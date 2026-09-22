import { Page, Browser, BrowserContext, PageScreenshotOptions } from "playwright";
import { ClickWebAction, HoverWebAction, ScrollWebAction, SwitchTabWebAction, TypeWebAction, WebAction } from '@/web/types';
import { PageStabilityAnalyzer } from "./stability";
import { parseTypeContent } from "./util";
import { ActionVisualizer, ActionVisualizerOptions } from "./visualizer";
import logger from "@/logger";
import { TabManager, TabState } from "./tabs";
import { DOMTransformer } from "./transformer";
import { Image } from '@/memory/image';
import EventEmitter from "eventemitter3";
import { checkOperation, currentOperation, drainAll, measureOperation, operationSleep, type Operation, type BrowserClickDiagnostics } from '@/common/operation';
//import { StateComponent } from "@/facets";


export interface WebHarnessOptions {
    //fallbackViewportDimensions?: { width: number, height: number}
    // Some LLM operate best on certain screen dims
    virtualScreenDimensions?: { width: number, height: number }
    visuals?: ActionVisualizerOptions
    switchTabsOnActivity?: boolean  // Whether to automatically switch tabs when user activity is detected vs only if switchTab is used
}

export interface WebHarnessEvents {
    'activePageChanged': (page: Page) => Promise<void>;
}

// Only standard names cross the diagnostic boundary, never custom element names or arbitrary roles.
const clickTags = ('a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr svg g path circle rect line polyline polygon ellipse text use symbol defs').split(' ');
const clickRoles = ('alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem').split(' ');

export class WebHarness { // implements StateComponent
    /**
     * Executes web actions on a page
     * Not responsible for browser lifecycle
     */
    public readonly context: BrowserContext;
    private options: WebHarnessOptions;
    private stability: PageStabilityAnalyzer;
    public readonly visualizer: ActionVisualizer;
    private transformer: DOMTransformer;
    private tabs: TabManager;
    private lastScreenshot?: { operation: Operation; dimensions: { width: number; height: number } };

    public readonly events: EventEmitter<WebHarnessEvents> = new EventEmitter();

    constructor(context: BrowserContext, options: WebHarnessOptions = {}) {
        //this.page = page;
        this.context = context;
        this.options = options;
        this.stability = new PageStabilityAnalyzer({ disableVisualStability: true });
        this.visualizer = new ActionVisualizer(this.context, this.options.visuals ?? {});
        this.transformer = new DOMTransformer();
        this.tabs = new TabManager(context, {
            switchOnActivity: options.switchTabsOnActivity ?? true
        });

        // this.context.on('page', (page: Page) => {
        //     this.setActivePage(page);
        //     //logger.info('ayo we got a new page');
        // });
        this.tabs.events.on('tabChanged', async (page: Page) => {
            await this.setActivePage(page);
            // need to wait for page to load before evaluating a script
            //page.on('load', () => { this.transformer.setActivePage(page); });
            
            //console.log('tabs:', await this.tabs.getState())

        }, this);
    }

    async setActivePage(page: Page) {
        logger.trace(`WebHarness active page: ${page.url()}`);
        this.stability.setActivePage(page);
        await this.visualizer.setActivePage(page);
        this.transformer.setActivePage(page);
        this.events.emit('activePageChanged', page);
    }

    async retrieveTabState(): Promise<TabState> {
        return this.tabs.retrieveState();
    }

    // setActivePage(page: Page) {
    //     this.page = page;
    //     this.stability.setActivePage(this.page);
    //     this.visualizer.setActivePage(this.page);
    // }

    async start() {
        // Initialize tab manager first
        await this.tabs.initialize();
        
        if (this.context.pages().length > 0) {
            // If context already contains a page, set it as active
            this.tabs.setActivePage(this.context.pages()[0]);
        } else {
            const page = await this.context.newPage();
            // Force the initial page to be set as active and emit tabChanged
            this.tabs.setActivePage(page);
        }
        await this.visualizer.setup();
    }

    async stop() {
        // Clean up tab manager resources
        this.tabs.destroy();
        this.lastScreenshot = undefined;
    }

    get page() {
        return this.tabs.getActivePage();
    }

    async screenshot(options: PageScreenshotOptions = {}): Promise<Image> {
        return measureOperation('screenshot', async () => {
            let dpr!: number;
            let buffer!: Buffer<ArrayBufferLike>;
            const retries = 3;
            for (let attempt = 0; attempt <= retries; attempt++) {
                checkOperation();
                try {
                    dpr = await this.page.evaluate(() => window.devicePixelRatio);
                    checkOperation();
                    buffer = await this.page.screenshot({ type: 'png', ...options });
                    checkOperation();
                    break;
                } catch (err) {
                    checkOperation();
                    const error = err as Error;
                    if (error.message.includes('Target page, context or browser has been closed')) {
                        throw new Error("Attempted to take screenshot but page, context or browser is closed");
                    }
                    if (attempt >= retries) {
                        throw new Error(`Unable to capture screenshot after retries, error: ${error.message}`);
                    }
                }
            }
            const image = Image.fromBase64(buffer.toString('base64'));
            // Match browser coordinate space while avoiding high-DPR image tokens.
            const { width, height } = await image.getDimensions();
            const resized = await image.resize(width / dpr, height / dpr);
            checkOperation();
            const operation = currentOperation();
            this.lastScreenshot = operation ? { operation,
                dimensions: this.options.virtualScreenDimensions ?? { width: width / dpr, height: height / dpr },
            } : undefined;
            return resized;
        });
    }
 
    // async goto(url: string) {
    //     // No need to redraw here anymore, the 'load' event listener handles it
    //     await this.page.goto(url);
    // }

    async _type(content: string) {
        /** Util for typing + keypresses */
        const chunks = parseTypeContent(content);

        // Total typing period to make typing more natural, in ms
        const totalTextDelay = 500;

        let totalTextLength = 0
        for (const chunk of chunks) {
            if (chunk != '<enter>' && chunk != '<tab>') {
                totalTextLength += chunk.length;
            }
        }

        for (const chunk of chunks) {
            checkOperation();
            if (chunk == '<enter>') {
                await this.page.keyboard.press('Enter');
            } else if (chunk == '<tab>') {
                await this.page.keyboard.press('Tab')
            } else {
                const chunkProportion = chunk.length / totalTextLength;
                const chunkDelay = totalTextDelay * chunkProportion;
                const chunkCharDelay = chunkDelay / chunk.length;
                await this.page.keyboard.type(chunk, {delay: chunkCharDelay});
            }
        }
    }

    // safer might be Coordinate interface/obj tied to certain screen space dims
    async transformCoordinates({ x, y }: { x: number, y: number }): Promise<{ x: number, y: number }> {
        const virtual = this.options.virtualScreenDimensions;
        if (!virtual) {
            return { x, y };
        }
        let vp = this.page.viewportSize();
        if (!vp) {
            vp = await this.page.evaluate(() => ({
                width: window.innerWidth,
                height: window.innerHeight
            }));
        }
        if (!vp) throw new Error("Could not get viewport dimensions to transform coordinates");
        return {
            x: x * (vp.width / virtual.width),
            y: y * (vp.height / virtual.height),
        };
    }

    async click({ x, y }: { x: number, y: number }, options?: { transform: boolean }) {
        if (options?.transform ?? true) ({ x, y } = await this.transformCoordinates({ x, y }));
        // console.log("x:", x);
        // console.log("y:", y);
        //await this.visualizer.visualizeAction(x, y);
        //await this.page.mouse.click(x, y);
        //await this.page.mouse.move(x, y, { steps: 20 });

        //console.log('clicking:', x, y);

        // const loc = this.page.getByText('Where are you going?');

        // console.log('found:', loc);
        
        // await loc.click();
        await this._click(x, y);
        

        
        // await this.page.waitForTimeout(1000);
        // await this.page.mouse.click(x, y);
        // await this.page.waitForTimeout(1000);
        // await this.page.mouse.click(x, y);
        // await this.page.waitForTimeout(1000);
        // await this.page.mouse.click(x, y);
        // await this.page.waitForTimeout(1000);
        // await this.page.mouse.click(x, y);
        // await this.page.waitForTimeout(1000);


        // await Promise.all([
        //     this.page.mouse.move(x, y, { steps: 20 }),
        //     this.visualizer.visualizeAction(x, y),
        // ]);
        // await this.page.mouse.down();
        // await this.page.waitForTimeout(200);
        // await this.page.mouse.up();

        // await this.page.evaluate(({ x, y }) => {
        //     // Find the topmost element at the given coordinates
        //     const targetElement = document.elementFromPoint(x, y);

        //     if (!targetElement) {
        //         console.error('No element found at coordinates:', x, y);
        //         return;
        //     }

        //     // Create and dispatch the events with properties that mimic a real click
        //     const options = {
        //         bubbles: true,
        //         cancelable: true,
        //         composed: true,
        //         // We can't set isTrusted, the browser forces it to false
        //     };

        //     targetElement.dispatchEvent(new MouseEvent('mouseover', options));
        //     targetElement.dispatchEvent(new MouseEvent('mousedown', options));
        //     targetElement.dispatchEvent(new MouseEvent('mouseup', options));
        //     targetElement.dispatchEvent(new MouseEvent('click', options));

        // }, { x, y });
        




        await this.waitForStability();
        //await this.visualizer.removeActionVisuals();
    }

    /** Recheck an observed target after hover effects, before submitting any click. */
    async clickGrounded(resolve: () => Promise<{ x: number; y: number } | null>): Promise<boolean> {
        const point = await resolve();
        if (!point) return false;
        const clicked = await this._click(point.x, point.y, undefined, async () => {
            const current = await resolve();
            return !!current && current.x === point.x && current.y === point.y;
        });
        if (clicked) await this.waitForStability();
        return clicked;
    }

    private async _click(x: number, y: number, options?: {
        button?: "left" | "right" | "middle";
        clickCount?: number;
        delay?: number;
    }, guard?: () => Promise<boolean>): Promise<boolean> {
        checkOperation();
        await drainAll([
            this.visualizer.moveVirtualCursor(x, y),
            this.page.mouse.move(x, y, { steps: 20 })
        ])
        // await this.visualizer.moveVirtualCursor(x, y);
        // await this.page.mouse.move(x, y, { steps: 20 });
        checkOperation();
        await this.visualizer.hideAll(); // The visualizer can block clicks.
        try {
            checkOperation();
            if (guard && !await guard()) return false;
            await this.dispatchClick(x, y, options);
            return true;
        } finally {
            await this.visualizer.showAll();
        }
    }

    private async dispatchClick(x: number, y: number, options: Parameters<Page['mouse']['click']>[2] = {}) {
        const page = this.page;
        const operation = currentOperation();
        let viewport = page.viewportSize();
        let hit: BrowserClickDiagnostics['hit'] = null;
        if (operation) {
            try {
                const state = await page.evaluate(({ x, y }) => {
                    let element = document.elementFromPoint(x, y);
                    for (let depth = 0; element?.shadowRoot && depth < 16; depth++) {
                        const child = element.shadowRoot.elementFromPoint(x, y);
                        if (child === element) break;
                        element = child;
                    }
                    // A frame element is not evidence about the target in its document.
                    if (element?.matches('iframe, frame') || element?.shadowRoot) element = null;
                    return {
                        viewport: { width: innerWidth, height: innerHeight },
                        hit: element ? { tag: element.localName.slice(0, 32), role: element.getAttribute('role')?.slice(0, 256) ?? null } : null,
                    };
                }, { x, y });
                if (!viewport && Number.isFinite(state.viewport.width) && Number.isFinite(state.viewport.height)) viewport = state.viewport;
                if (state.hit) hit = {
                    tag: clickTags.includes(state.hit.tag) ? state.hit.tag : null,
                    role: state.hit.role?.split(/\s+/).find(role => clickRoles.includes(role)) ?? null,
                };
            } catch { /* Inspection is optional; a navigation or unavailable document leaves unknown evidence. */ }
        }
        checkOperation();
        const pending = options.clickCount === 2 ? page.mouse.dblclick(x, y, options) : page.mouse.click(x, y, options);
        // Publish after submitting the command, so a diagnostic listener cannot cancel before dispatch.
        operation?.recordClick({ x, y, button: options.button ?? 'left', clickCount: options.clickCount ?? 1,
            screenshot: this.lastScreenshot?.operation === operation ? this.lastScreenshot.dimensions : null,
            viewport, hit,
        });
        await pending;
    }

    async hover({ x, y }: { x: number, y: number }, options?: { transform: boolean }) {
        if (options?.transform ?? true) ({ x, y } = await this.transformCoordinates({ x, y }));
        checkOperation();
        await drainAll([
            this.visualizer.moveVirtualCursor(x, y),
            this.page.mouse.move(x, y, { steps: 20 })
        ]);
        await this.waitForStability();
    }

    async rightClick({ x, y }: { x: number, y: number }, options?: { transform: boolean }) {
        if (options?.transform ?? true) ({ x, y } = await this.transformCoordinates({ x, y }));
        await this._click(x, y, { button: "right" });
        await this.waitForStability();
    }

    async doubleClick({ x, y }: { x: number, y: number }, options?: { transform: boolean }) {
        if (options?.transform ?? true) ({ x, y } = await this.transformCoordinates({ x, y }));
        checkOperation();
        await this.visualizer.moveVirtualCursor(x, y);
        checkOperation();
        await this.visualizer.hideAll();
        try {
            checkOperation();
            await this.dispatchClick(x, y, { clickCount: 2 });
        } finally {
            await this.visualizer.showAll();
        }
        await this.waitForStability();
    }

    async drag({ x1, y1, x2, y2 }: { x1: number, y1: number, x2: number, y2: number }, options?: { transform: boolean }) {
        if (options?.transform ?? true) ({ x: x1, y: y1 } = await this.transformCoordinates({ x: x1, y: y1 }));
        if (options?.transform ?? true) ({ x: x2, y: y2 } = await this.transformCoordinates({ x: x2, y: y2 }));

        //console.log(`Dragging: (${x1}, ${y1}) -> (${x2}, ${y2})`);
        
        checkOperation();
        await this.page.mouse.move(x1, y1, { steps: 1 });
        checkOperation();
        await this.page.mouse.down();
        try {
            checkOperation();
            await this.visualizer.moveVirtualCursor(x1, y1);
            await operationSleep(500);
            checkOperation();
            await drainAll([
                this.page.mouse.move(x2, y2, { steps: 20 }),
                this.visualizer.moveVirtualCursor(x2, y2)
            ]);
        } finally {
            // Release input state even on cancellation; an already-sent drag cannot be undone.
            await this.page.mouse.up();
        }
        await this.waitForStability();
        //await this.visualizer.removeActionVisuals();
    }

    async type({ content }: { content: string }) {
        await this._type(content);
        await this.waitForStability();
    }

    async clickAndType({ x, y, content }: { x: number, y: number, content: string }, options?: { transform: boolean }) {
        // TODO: transforms incorrect for moondream grounding with virtual screen dims (claude) - unsure why
        //console.log(`Pre transform: ${x}, ${y}`);
        if (options?.transform ?? true) ({ x, y } = await this.transformCoordinates({ x, y }));
        //console.log(`Post transform: ${x}, ${y}`);
        await this._click(x, y);
        await this._type(content);
        await this.waitForStability();
    }
    
    async scroll({ x, y, deltaX, deltaY }: { x: number, y: number, deltaX: number, deltaY: number }, options?: { transform: boolean }) {
        if (options?.transform ?? true) ({ x, y } = await this.transformCoordinates({ x, y }));
        checkOperation();
        await this.visualizer.moveVirtualCursor(x, y);
        checkOperation();
        await this.page.mouse.move(x, y);
        checkOperation();
        await this.page.mouse.wheel(deltaX, deltaY);
        await this.waitForStability();
    }

    async switchTab({ index }: { index: number }) {
        checkOperation();
        await this.tabs.switchTab(index);
        await this.waitForStability();
    }

    async newTab() {
        checkOperation();
        const page = await this.context.newPage();
        await this.switchTab({ index: this.context.pages().indexOf(page) });
    }

    async navigate(url: string) {
        checkOperation();
        // Only wait for DOM content on goto since we handle waiting for network idle etc ourselves
        await this.page.goto(url, { waitUntil: 'domcontentloaded' });
        await this.waitForStability();
    }

    async selectAll() {
        checkOperation();
        await this.page.keyboard.down('ControlOrMeta');
        try {
            checkOperation();
            await this.page.keyboard.press('KeyA');
        } finally {
            await this.page.keyboard.up('ControlOrMeta');
        }
    }

    async enter() {
        checkOperation();
        await this.page.keyboard.press('Enter')
    }

    async backspace() {
        checkOperation();
        await this.page.keyboard.press('Backspace')
    }

    async tab() {
        checkOperation();
        await this.page.keyboard.press('Tab')
    }

    async goBack() {
        checkOperation();
        await this.page.goBack();
    }

    async escape() {
        checkOperation();
        await this.page.keyboard.press('Escape');
    }

    async executeAction(action: WebAction) {
        if (action.variant === 'click') {
            await this.click(action);
        } else if (action.variant === 'hover') {
            await this.hover(action);
        } else if (action.variant === 'type') {
            await this.clickAndType(action);
        } else if (action.variant === 'scroll') {
            await this.scroll(action);
        } else if (action.variant === 'tab') {
            await this.switchTab(action);
        } else {
            throw Error(`Unhandled web action variant: ${(action as any).variant}`);
        }
        //await this.stability.waitForStability();
        //await this.visualizer.redrawLastPosition();
    }

    async waitForStability(timeout?: number): Promise<void> {
        checkOperation();
        await measureOperation('stability', () => this.stability.waitForStability(timeout));
        checkOperation();
    }

    // async applyTransformations() {
    //     const start = Date.now();
    //     await this.transformer.applyTransformations();
    //     logger.trace(`DOM transformations took ${Date.now() - start}ms`);
    // }

    // async waitForStability(timeout?: number): Promise<void> {
    //     await this.stability.waitForStability(timeout);
    // }
}
