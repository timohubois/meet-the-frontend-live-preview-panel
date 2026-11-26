import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { testInChromium, withChromiumInput, withChromiumPage } from './helpers/chromium.mjs';

const guard = await readFile(new URL('../build/preview-navigation.js', import.meta.url));
const previewPath = '/preview?mtflpp_token=fixture';
const preview = `<!doctype html><html><head>
    <link rel="icon" href="data:,">
    <style>body > a { display: block; width: max-content; }</style>
    <script src="/preview-navigation.js"></script></head><body>
    <a id="placeholder" href="#"><span>Open controls</span></a>
    <a id="plain" href="/out/plain">Ordinary link</a>
    <a id="differentQuery" href="/preview?other=1#details">Different query</a>
    <a id="download" href="/out/document" download>Download</a>
    <a id="fragmentDownload" href="#details" download>Download fragment URL</a>
    <a id="newTab" href="#details" target="_blank">Open fragment in another tab</a>
    <a id="fragment" href="#details">Jump to details</a>
    <form id="form" action="/out/submit" method="post">
        <input id="input" name="test" value="fixture">
        <button id="send" type="submit">Submit</button>
        <button id="control" type="button">Non-submit action</button>
    </form>
    <svg width="80" height="30">
        <a href="#details" xlink:show="new"><rect id="svgXLink" width="80" height="30"/></a>
    </svg>
    <svg width="80" height="30">
        <a id="svgAnimated" href="#details" target="_self">
            <set attributeName="target" to="_blank" begin="0s" dur="indefinite"/>
            <rect width="80" height="30"/>
        </a>
    </svg>
    <div style="height:800px"></div><div id="details">Details</div>
    <script>
        const events = window.events = [];
        window.addEventListener('submit', event => { window.lastSubmit = event; }, true);
        function record(where, event) {
            events.push([where, event.type, event.isTrusted, event.defaultPrevented]);
        }
        for (const type of ['click', 'auxclick', 'submit']) {
            for (const element of document.querySelectorAll('a, button, form')) {
                if (element.matches('form') !== (type === 'submit')) continue;
                element.addEventListener(type, event => {
                    record('target', event);
                    if (element.id === 'plain' && type === 'click') event.stopPropagation();
                });
            }
            document.addEventListener(type, event => record('delegate', event));
        }
    </script></body></html>`;

async function withPreviewServer(run) {
    const requests = [];
    const server = createServer((req, res) => {
        if (req.url === '/preview-navigation.js') {
            res.setHeader('Content-Type', 'application/javascript');
            res.end(guard);
        } else if (req.url === '/parent') {
            res.setHeader('Content-Type', 'text/html');
            res.end(`<!doctype html><link rel="icon" href="data:,"><iframe id="preview" width="640" height="420" src="${previewPath}"></iframe>`);
        } else if (req.url === previewPath) {
            res.setHeader('Content-Type', 'text/html');
            res.end(preview);
        } else {
            requests.push([req.method, req.url]);
            if (req.url === '/out/document') res.setHeader('Content-Disposition', 'attachment; filename="fixture.txt"');
            res.end('Fixture destination');
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        await run(`http://127.0.0.1:${server.address().port}${previewPath}`, requests);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

testInChromium('preview clicks reach frontend handlers without displacing the native preview', { timeout: 30000 }, async (t) => {
    await withPreviewServer((href, requests) => withChromiumPage('', ({ args }) => withChromiumInput(
        t, new URL('/parent', href).href, [...args, '--disable-smooth-scrolling'], async ({ send, evaluate }) => {
            const read = (expression) => evaluate(`(() => {
                const frame = document.getElementById('preview');
                const page = frame?.contentWindow;
                return ${expression};
            })()`);
            for (let i = 0; i < 100 && !(await read('!!page?.events')); i++) await delay(10);
            assert.equal(await read('page?.location.href'), href);
            const openTabs = async () => (await send('Target.getTargets')).targetInfos.filter(({ type }) => type === 'page').length;
            const initialTabs = await openTabs();
            const click = async (selector, { button = 'left', modifiers = 0 } = {}) => {
                const { x, y } = await read(`(() => {
                    const rect = page.document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
                    const outer = frame.getBoundingClientRect();
                    return { x: outer.x + frame.clientLeft + rect.x + rect.width / 2,
                        y: outer.y + frame.clientTop + rect.y + rect.height / 2 };
                })()`);
                for (const type of ['mousePressed', 'mouseReleased']) {
                    await send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1, modifiers });
                }
            };
            const enter = async (id) => {
                await read(`page.document.getElementById(${JSON.stringify(id)}).focus()`);
                for (const type of ['keyDown', 'keyUp']) {
                    await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
                        text: type === 'keyDown' ? '\r' : '' });
                }
            };
            const expectActivation = async (activate, { prevented = true, type = 'click', delegated = true } = {}) => {
                await read('page.events.length = 0');
                await activate();
                const phases = delegated ? ['target', 'delegate'] : ['target'];
                assert.deepEqual(await read('page.events'), phases.map((phase) => [phase, type, true, prevented]));
            };

            await t.test('a placeholder runs direct and delegated handlers by pointer and Enter', async () => {
                await expectActivation(() => click('#placeholder span'));
                await expectActivation(() => enter('placeholder'));
                await expectActivation(() => click('#control'), { prevented: false });
                assert.equal(await read('page.location.href'), href);
            });
            await t.test('capture still cancels navigation, downloads and new tabs without swallowing clicks', async () => {
                await expectActivation(() => click('#plain'), { delegated: false });
                await expectActivation(() => click('#plain', { button: 'middle' }), { type: 'auxclick' });
                for (const selector of ['#differentQuery', '#download', '#fragmentDownload', '#newTab']) {
                    await expectActivation(() => click(selector));
                }
                await expectActivation(() => click('#fragment', { modifiers: 2 })); // Ctrl-click
                await read(`page.document.head.append(Object.assign(page.document.createElement('base'), { target: '_blank' }))`);
                try {
                    await expectActivation(() => click('#fragment'));
                    await read(`page.document.getElementById('fragment').target = ''`);
                    await expectActivation(() => click('#fragment'));
                } finally {
                    await read(`(() => {
                        page.document.getElementById('fragment').removeAttribute('target');
                        page.document.querySelector('base').remove();
                    })()`);
                }
                assert.equal(await read('page.location.href'), href);
                assert.equal(await openTabs(), initialTabs);
                assert.deepEqual(requests, []);
            });
            await t.test('SVG fragment clicks reach handlers without opening native popup targets', async () => {
                assert.equal(await read(`page.document.getElementById('svgAnimated').target.animVal`), '_blank');
                await expectActivation(() => click('#svgXLink'));
                await expectActivation(() => click('#svgAnimated rect'));
                assert.equal(await read('page.location.href'), href);
                assert.equal(await openTabs(), initialTabs);
            });
            await t.test('normal form submit is still canceled and stopped but its button click is not', async () => {
                for (const activate of [() => click('#send'), () => enter('input')]) {
                    await read('page.lastSubmit = null');
                    await expectActivation(activate, { prevented: false });
                    assert.equal(await read('page.lastSubmit?.defaultPrevented'), true);
                }
                await read('page.events.length = 0');
                await read('page.lastSubmit = null');
                await read('page.document.getElementById("form").requestSubmit()');
                assert.equal(await read('page.lastSubmit?.defaultPrevented'), true);
                assert.deepEqual(await read('page.events'), []);
                assert.equal(await read('page.location.href'), href);
                assert.deepEqual(requests, []);
            });
            await t.test('a real fragment jumps natively in the same document', async () => {
                const before = await read('page.scrollY');
                await expectActivation(() => click('#fragment'), { prevented: false });
                assert.equal(await read('page.location.href'), `${href}#details`);
                await read('new Promise(resolve => page.requestAnimationFrame(() => resolve()))');
                assert.ok(await read('page.scrollY') > before);
                await read(`(() => {
                    page.document.head.append(Object.assign(page.document.createElement('base'), { target: '_blank' }));
                    page.document.getElementById('fragment').target = '_self';
                })()`);
                await expectActivation(() => enter('fragment'), { prevented: false });
                assert.equal(await read('page.location.href'), `${href}#details`);
                assert.equal(await openTabs(), initialTabs);
                assert.deepEqual(requests, []);
            });
        }
    )));
});
