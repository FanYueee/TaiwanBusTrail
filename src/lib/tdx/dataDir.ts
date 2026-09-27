import path from "node:path";

export const tdxDataFile = (name: string) => process.env.TCBUS_DATA_DIR
  // Custom datasets are supplied on disk by the deployment, outside the bundle.
  ? path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.TCBUS_DATA_DIR, name)
  : path.join(process.cwd(), "data", "tdx", name);
