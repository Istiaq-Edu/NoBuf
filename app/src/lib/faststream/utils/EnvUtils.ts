export class EnvUtils {
  static isExtension(): boolean {
    return false; // Running in Tauri, not as browser extension
  }

  static isChrome(): boolean {
    return navigator.userAgent.includes('Chrome');
  }

  static isFirefox(): boolean {
    return navigator.userAgent.includes('Firefox');
  }

  static getVersion(): string {
    return '1.4.0'; // nobuff version
  }

  static isMobile(): boolean {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }
}
