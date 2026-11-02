import { createIframeQueryClient, type IframeQueryClient } from './iframe-sdk';

declare global { interface Window { aside?: IframeQueryClient } }
window.aside ??= createIframeQueryClient(window);
