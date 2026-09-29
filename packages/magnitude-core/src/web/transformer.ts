import type { Frame, Page } from 'playwright';
import getShadowDOMInputAdapterScript from './scripts/shadowDOMInputAdapter';
import logger from '@/logger';

export class DOMTransformer {
    private initializedPages = new WeakSet<Page>(); // Track pages for which 'load' listener is set

    constructor() {}

    public setActivePage(newPage: Page) {
        // Only add the 'load' listener if we haven't done so for this specific Page object instance.
        if (!this.initializedPages.has(newPage)) {
            newPage.on('load', async () => {
                // Pass 'newPage' (the page that triggered the 'load' event) to setupScriptForPage.
                await this.setupScriptForPage(newPage);
            });
            // An iframe can navigate without a page 'load' event.
            newPage.on('framenavigated', async frame => {
                if (frame.parentFrame() && this.isSameOrigin(frame)) {
                    await frame.waitForLoadState('domcontentloaded').catch(() => {});
                    await this.setupScriptForFrame(frame);
                }
            });
            this.initializedPages.add(newPage); // Mark this Page object as having its 'load' listener set up.
            // A page that loaded before it was tracked never fires 'load' again.
            void this.setupScriptForPage(newPage);
        }
    }

    // Same-origin iframes get the adapter too, so their selects and dates behave like the page's.
    // Other origins are left unchanged.
    private isSameOrigin(frame: Frame) {
        try {
            return new URL(frame.url()).origin === new URL(frame.page().mainFrame().url()).origin;
        } catch {
            return false;
        }
    }

    public async setupScriptForPage(targetPage: Page) {
        const frames = targetPage.frames().filter(frame => !frame.parentFrame() || this.isSameOrigin(frame));
        await Promise.all(frames.map(frame => this.setupScriptForFrame(frame)));
    }

    private async setupScriptForFrame(frame: Frame) {
        try {
            // Check if a marker for the script already exists in the frame for this load cycle.
            const scriptAlreadyInjected = await frame.evaluate(() => {
                return (window as any).__magnitudeShadowDOMAdapterInjected === true;
            }).catch(() => false); // If evaluate fails (e.g., frame detached), assume not injected.

            if (scriptAlreadyInjected) {
                logger.trace('Select manager script already present on this page load.');
                return;
            }

            // Get the script as a string from the separate file
            const scriptFnString = getShadowDOMInputAdapterScript();

            // Evaluate the script function in the browser and set the marker.
            // We need to wrap it in a self-executing function
            await frame.evaluate(`
                (${scriptFnString})();
                window.__magnitudeShadowDOMAdapterInjected = true;
            `);

            logger.trace(`Script injected into frame: ${frame.url()}`);
        } catch (error) {
            const url = frame.isDetached() ? '[detached frame]' : frame.url();
            logger.warn(`Error injecting script into ${url}: ${(error as Error).message}`);
        }
    }
}
