/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.py?raw" {
  const source: string;
  export default source;
}

interface Window {
  ethereum?: import("./live/eip1193").Eip1193Provider;
}
