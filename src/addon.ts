import { config } from "../package.json";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import { buildOutputPath } from "./modules/converter";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    notifierID?: string;
  };

  public hooks: typeof hooks;

  // Public API for testing and external access
  public api: {
    buildOutputPath: typeof buildOutputPath;
  };

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.api = { buildOutputPath };
  }
}

export default Addon;
