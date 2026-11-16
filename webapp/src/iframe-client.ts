import { createIframeQueryClient, type IframeQueryClient } from './iframe-sdk';

declare global { interface Window { aside?: IframeQueryClient } }
const script = document.currentScript;
const token = script?.getAttribute('data-aside-token');
const parentOrigin = script?.getAttribute('data-aside-origin');
window.aside = createIframeQueryClient(window, token && parentOrigin ? { token, parentOrigin } : undefined);
