import { getString, initLocale } from "./utils/locale";
import { getPref } from "./utils/prefs";
import { createZToolkit } from "./utils/ztoolkit";
import {
  convertAttachment,
  detectPython,
  verifyEngine,
} from "./modules/converter";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Register preferences pane
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });

  // Auto-detect python3 and verify converter engine
  const pythonPath = await detectPython();
  if (pythonPath) {
    ztoolkit.log(`[ZoteroMD] python3 found at: ${pythonPath}`);
    const engine = getPref("converterEngine") || "docling";
    verifyEngine(pythonPath, engine).then((ok) => {
      if (!ok) {
        setTimeout(() => {
          new ztoolkit.ProgressWindow(addon.data.config.addonName, {
            closeOnClick: true,
            closeTime: -1,
          })
            .createLine({
              text: getString("engine-not-found", {
                args: { engine },
              }),
              type: "fail",
              progress: 100,
            })
            .show()
            .startCloseTimer(10000);
        }, 2000);
      }
    });
  } else {
    ztoolkit.log("[ZoteroMD] python3 not found");
    setTimeout(() => {
      new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
        closeTime: -1,
      })
        .createLine({
          text: getString("python-not-found"),
          type: "fail",
          progress: 100,
        })
        .show()
        .startCloseTimer(10000);
    }, 2000);
  }

  // Register notifier to watch for new PDF attachments
  const callback = {
    notify: async (
      event: string,
      type: string,
      ids: number[] | string[],
      extraData: { [key: string]: any },
    ) => {
      if (!addon?.data.alive) {
        unregisterNotifier();
        return;
      }
      onNotify(event, type, ids, extraData);
    },
  };

  addon.data.notifierID = Zotero.Notifier.registerObserver(callback, ["item"]);

  Zotero.Plugins.addObserver({
    shutdown: ({ id }: { id: string }) => {
      if (id === addon.data.config.addonID) unregisterNotifier();
    },
  });

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

/**
 * Register menus by injecting XUL elements directly into the Zotero DOM.
 * Works on Zotero 7, 8, and 9. Elements are tracked by ztoolkit and removed
 * on window unload via ztoolkit.unregisterAll().
 */
function registerMenus(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  const icon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;

  const itemMenu = doc.getElementById("zotero-itemmenu");
  if (itemMenu) {
    ztoolkit.UI.appendElement(
      {
        tag: "menuitem",
        id: `${addon.data.config.addonRef}-convert-selected`,
        attributes: {
          label: getString("menu-convert-selected"),
          image: icon,
          class: "menuitem-iconic",
        },
        listeners: [
          { type: "command", listener: () => convertSelectedItems() },
        ],
      },
      itemMenu,
    );
  }

  const toolsMenu = doc.getElementById("menu_ToolsPopup");
  if (toolsMenu) {
    ztoolkit.UI.appendElement(
      {
        tag: "menuitem",
        id: `${addon.data.config.addonRef}-convert-all`,
        attributes: {
          label: getString("menu-convert-all"),
          image: icon,
          class: "menuitem-iconic",
        },
        listeners: [{ type: "command", listener: () => convertAllPdfs() }],
      },
      toolsMenu,
    );
  }
}

function unregisterNotifier() {
  if (addon.data.notifierID) {
    Zotero.Notifier.unregisterObserver(addon.data.notifierID);
    addon.data.notifierID = undefined;
  }
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  // Ensure addon FTL strings are available in this window's l10n context.
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Zotero 7/8/9: inject menu items into the DOM per-window.
  registerMenus(win);

  const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text: getString("startup-begin"),
      type: "default",
      progress: 0,
    })
    .show();

  popupWin.changeLine({
    progress: 100,
    text: getString("startup-finish"),
  });
  popupWin.startCloseTimer(3000);
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  unregisterNotifier();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  _extraData: { [key: string]: any },
) {
  if (event !== "add" || type !== "item") return;
  if (!getPref("autoConvert")) return;

  for (const id of ids) {
    const item = Zotero.Items.get(id as number);
    if (!item?.isAttachment()) continue;
    if (item.attachmentContentType !== "application/pdf") continue;

    // Skip if a Markdown attachment already exists on the parent item
    const parentID = item.parentItemID;
    if (parentID) {
      const parent = Zotero.Items.get(parentID);
      const siblings: number[] = parent.getAttachments();
      const alreadyConverted = siblings.some((sibID: number) => {
        const sib = Zotero.Items.get(sibID);
        return sib?.attachmentContentType === "text/markdown";
      });
      if (alreadyConverted) continue;
    }

    // Fire-and-forget conversion in background
    triggerConversion(item);
  }
}

async function triggerConversion(item: Zotero.Item): Promise<void> {
  const engine = getPref("converterEngine") || "docling";
  const pw = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: false,
    closeTime: -1,
  })
    .createLine({
      text: getString("conversion-started", { args: { engine } }),
      type: "default",
      progress: 0,
    })
    .show();

  try {
    const outputPath = await convertAttachment(item);
    const filename = PathUtils.filename(outputPath);

    pw.changeLine({
      text: getString("conversion-success", { args: { filename } }),
      type: "success",
      progress: 100,
    });

    if (getPref("attachResult")) {
      await attachMarkdown(item, outputPath);
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    pw.changeLine({
      text: getString("conversion-failed", { args: { error } }),
      type: "fail",
      progress: 100,
    });
    ztoolkit.log(`[ZoteroMD] Conversion error for item ${item.id}: ${error}`);
  } finally {
    pw.startCloseTimer(5000);
  }
}

async function attachMarkdown(
  pdfItem: Zotero.Item,
  mdPath: string,
): Promise<void> {
  const parentID = pdfItem.parentItemID;
  if (!parentID) return;

  // Verify file exists before attaching (IOUtils compatible with Zotero 7, 8, 9)
  if (!(await IOUtils.exists(mdPath))) {
    ztoolkit.log(`[ZoteroMD] Cannot attach: file not found at ${mdPath}`);
    return;
  }

  // Import the .md file as a stored attachment on the parent item
  const importedItem = await Zotero.Attachments.importFromFile({
    file: mdPath,
    parentItemID: parentID,
  });
  if (importedItem) {
    importedItem.setField("title", PathUtils.filename(mdPath));
    importedItem.attachmentContentType = "text/markdown";
    await importedItem.saveTx();
    ztoolkit.log(
      `[ZoteroMD] Attached markdown as item ${importedItem.id} to parent ${parentID}`,
    );
  }
}

/**
 * Finds all PDF attachment items for a given parent item.
 * If the item itself is a PDF attachment, returns it directly.
 */
function getPdfAttachments(item: Zotero.Item): Zotero.Item[] {
  if (item.isAttachment()) {
    if (item.attachmentContentType === "application/pdf") return [item];
    return [];
  }
  const attachmentIDs: number[] = item.getAttachments();
  return attachmentIDs
    .map((id) => Zotero.Items.get(id))
    .filter(
      (att) => att?.attachmentContentType === "application/pdf",
    ) as Zotero.Item[];
}

/**
 * Checks whether a parent item already has a .md attachment.
 */
function hasMdAttachment(item: Zotero.Item): boolean {
  const parentID = item.isAttachment() ? item.parentItemID : item.id;
  if (!parentID) return false;
  const parent = Zotero.Items.get(parentID);
  const siblings: number[] = parent.getAttachments();
  return siblings.some((sibID: number) => {
    const sib = Zotero.Items.get(sibID);
    return sib?.attachmentContentType === "text/markdown";
  });
}

/**
 * Right-click menu handler: convert selected items' PDFs to Markdown.
 */
async function convertSelectedItems(): Promise<void> {
  const zoteroPane = ztoolkit.getGlobal("ZoteroPane");
  const selectedItems = zoteroPane.getSelectedItems() as Zotero.Item[];
  if (!selectedItems.length) return;

  const pdfItems: Zotero.Item[] = [];
  for (const item of selectedItems) {
    for (const pdf of getPdfAttachments(item)) {
      if (!hasMdAttachment(pdf)) {
        pdfItems.push(pdf);
      }
    }
  }

  if (!pdfItems.length) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: "No unconverted PDFs in selection.",
        type: "default",
        progress: 100,
      })
      .show()
      .startCloseTimer(3000);
    return;
  }

  await batchConvert(pdfItems);
}

/**
 * Tools menu handler: convert ALL PDFs in the entire library.
 */
async function convertAllPdfs(): Promise<void> {
  try {
    const libraryID = Zotero.Libraries.userLibraryID;
    const s = new Zotero.Search({ libraryID });
    s.addCondition("itemType", "is", "attachment");
    s.addCondition("contentType", "is", "application/pdf");
    const ids = await s.search();

    ztoolkit.log(`[ZoteroMD] Convert All: found ${ids.length} PDF attachments`);

    const pdfItems: Zotero.Item[] = [];
    for (const id of ids) {
      const item = Zotero.Items.get(id) as Zotero.Item;
      if (item && !hasMdAttachment(item)) {
        pdfItems.push(item);
      }
    }

    ztoolkit.log(
      `[ZoteroMD] Convert All: ${pdfItems.length} PDFs need conversion (${ids.length - pdfItems.length} already have .md)`,
    );

    if (!pdfItems.length) {
      new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: `All ${ids.length} PDFs already converted.`,
          type: "success",
          progress: 100,
        })
        .show()
        .startCloseTimer(3000);
      return;
    }

    // Show count before starting
    new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: `Starting batch: ${pdfItems.length} PDFs to convert`,
        type: "default",
        progress: 0,
      })
      .show()
      .startCloseTimer(3000);

    await batchConvert(pdfItems);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    ztoolkit.log(`[ZoteroMD] Convert All error: ${error}`);
    new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: getString("conversion-failed", { args: { error } }),
        type: "fail",
        progress: 100,
      })
      .show()
      .startCloseTimer(5000);
  }
}

/**
 * Sequentially converts a list of PDF items, showing a progress window.
 */
async function batchConvert(pdfItems: Zotero.Item[]): Promise<void> {
  const total = pdfItems.length;
  let done = 0;
  let skipped = 0;
  const engine = getPref("converterEngine") || "docling";

  const pw = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: false,
    closeTime: -1,
  })
    .createLine({
      text: getString("batch-progress", {
        args: { done: String(done), total: String(total) },
      }),
      type: "default",
      progress: 0,
    })
    .show();

  for (const pdfItem of pdfItems) {
    try {
      const outputPath = await convertAttachment(pdfItem);
      if (getPref("attachResult")) {
        await attachMarkdown(pdfItem, outputPath);
      }
      done++;
    } catch (e) {
      skipped++;
      ztoolkit.log(
        `[ZoteroMD] Batch: failed item ${pdfItem.id}: ${e instanceof Error ? e.message : e}`,
      );
    }

    pw.changeLine({
      text: getString("batch-progress", {
        args: { done: String(done + skipped), total: String(total) },
      }),
      progress: Math.round(((done + skipped) / total) * 100),
    });
  }

  pw.changeLine({
    text: getString("batch-complete", {
      args: { done: String(done), total: String(total) },
    }),
    type: done > 0 ? "success" : "fail",
    progress: 100,
  });
  pw.startCloseTimer(8000);

  if (skipped > 0) {
    ztoolkit.log(`[ZoteroMD] Batch: ${skipped} items failed`);
  }
}

async function onPrefsEvent(type: string, _data: { [key: string]: any }) {
  ztoolkit.log(`[ZoteroMD] prefs event: ${type}`);
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
};
