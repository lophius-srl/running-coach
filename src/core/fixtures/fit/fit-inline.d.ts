// Fixtures FIT importées par les tests en data URL base64 (`assetsInclude` de vitest.config.ts).
declare module "*.fit?inline" {
  const dataUrl: string;
  export default dataUrl;
}
