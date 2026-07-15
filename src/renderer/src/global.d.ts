import type { KozouDesktopApi } from '../../shared/types';

declare global {
  interface Window {
    kozouDesktop: KozouDesktopApi;
  }
}

export {};
