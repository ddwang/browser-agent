import { describe, expect, test, beforeEach } from 'bun:test';
import { BrowserProvider } from '@/web/browserProvider';

beforeEach(async () => {
    // Ensure clean state before each test
    await BrowserProvider.reset();
});

test.each([
    {
        selection: 'channel',
        options: { channel: 'magnitude-missing-channel' },
        error: 'magnitude-missing-channel',
    },
    {
        selection: 'executable path',
        options: { executablePath: '/magnitude-missing-browser' },
        error: "executable doesn't exist at /magnitude-missing-browser",
    },
    {
        selection: 'executable path over channel',
        options: { channel: 'magnitude-missing-channel', executablePath: '/magnitude-missing-browser' },
        error: "executable doesn't exist at /magnitude-missing-browser",
    },
])('preserves an explicit $selection instead of falling back to Chrome', async ({ options, error }) => {
    try {
        await expect(BrowserProvider.getInstance().newContext({
            launchOptions: { headless: true, ...options },
        })).rejects.toThrow(error);
    } finally {
        await BrowserProvider.reset();
    }
});

describe('BrowserProvider.reset()', () => {
    test('is idempotent when no instance exists', async () => {
        expect((globalThis as any).__magnitude__?.browserProvider).toBeUndefined();
        // Should not throw
        await BrowserProvider.reset();
        expect((globalThis as any).__magnitude__?.browserProvider).toBeUndefined();
    });

    test('is idempotent when instance exists but has no browsers', async () => {
        // Force creation of singleton with no active browsers
        BrowserProvider.getInstance();
        expect((globalThis as any).__magnitude__.browserProvider).toBeDefined();

        await BrowserProvider.reset();
        expect((globalThis as any).__magnitude__.browserProvider).toBeUndefined();
    });

    test.each([
        { selection: 'omitted', options: {} },
        { selection: 'undefined', options: { channel: undefined } },
        { selection: 'explicit Chrome', options: { channel: 'chrome' } },
    ])('closes active browsers and clears singleton ($selection channel)', async ({ options }) => {
        const instance = BrowserProvider.getInstance();

        // Create a context which launches a real browser
        const context = await instance.newContext({ launchOptions: { headless: true, ...options } });
        const browser = context.browser();
        expect(browser).not.toBeNull();
        console.log(`BrowserProvider smoke: Chrome ${browser?.version()}`);
        // Chromium 156.0.8078.4 in Patchright 1.64.3 predates this security update.
        expect((browser?.version() ?? '').localeCompare('156.0.8078.47', undefined, { numeric: true })).toBeGreaterThanOrEqual(0);
        const page = await context.newPage();
        await page.setContent('<button onclick="this.textContent=\'Clicked\'">Click me</button>');
        await page.getByRole('button', { name: 'Click me' }).click();
        expect(await page.getByRole('button').textContent()).toBe('Clicked');

        // Verify a browser is tracked
        expect(Object.keys((instance as any).activeBrowsers).length).toBeGreaterThan(0);

        await BrowserProvider.reset();

        // Singleton should be cleared
        expect((globalThis as any).__magnitude__.browserProvider).toBeUndefined();

        // activeBrowsers on the old instance should be empty
        expect(Object.keys((instance as any).activeBrowsers).length).toBe(0);
    });

    test('does not throw if browser is already closed', async () => {
        const instance = BrowserProvider.getInstance();
        await instance.newContext({ launchOptions: { headless: true } });

        // Close the browser before reset
        const activeBrowser = Object.values((instance as any).activeBrowsers)[0] as any;
        const browser = await activeBrowser.browserPromise;
        await browser.close();

        // reset() should still succeed
        await BrowserProvider.reset();
        expect((globalThis as any).__magnitude__.browserProvider).toBeUndefined();
    });
});
