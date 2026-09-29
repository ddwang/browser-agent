import type { Frame } from 'playwright';

// Native select popups render outside the page, so screenshots never show their options.
// Chrome 135+ draws a base-select picker in the page's top layer, where screenshots include it.
// Multi-selects and list boxes already render in the page.
const CSS = 'select:not([multiple]):not([size]), select:not([multiple]):not([size])::picker(select) { appearance: base-select; }';

// A constructed stylesheet adds no DOM node, so the page's own markup is unchanged.
function install(css: string) {
    const sheets = document.adoptedStyleSheets;
    if (sheets.some(sheet => sheet.cssRules[0]?.cssText.includes('base-select'))) return;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...sheets, sheet];
}

/** Applies to one document; the transformer calls it for each frame load and navigation. */
export async function renderSelectPickersInFrame(frame: Frame) {
    await frame.evaluate(install, CSS).catch(() => {}); // A detached or navigating frame has no document to style.
}
