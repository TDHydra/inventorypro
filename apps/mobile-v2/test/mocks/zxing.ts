// @zxing/browser is the WEB barcode decoder (scan screen's web twin). It needs
// a real <video> + camera stream; stubbed so the screen mounts.
export class BrowserMultiFormatReader {
  async decodeFromVideoDevice() { return { getText: () => '' }; }
  async listVideoInputDevices() { return []; }
  reset() {}
}
export class BrowserQRCodeReader extends BrowserMultiFormatReader {}
