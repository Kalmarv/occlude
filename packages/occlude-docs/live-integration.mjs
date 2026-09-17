/**
 * Astro integration: every docs page loads the studio's live-example
 * script from the same origin. In `blume dev` the studio is another port,
 * so its script, worker, wasm and API are proxied to look same-origin.
 */
export default function occludeLive({ studio = 'http://127.0.0.1:4173' } = {}) {
  return {
    name: 'occlude-live',
    hooks: {
      'astro:config:setup': ({ injectScript, updateConfig }) => {
        injectScript('page', `const s = document.createElement('script'); s.type = 'module'; s.src = '/live-embed.js'; document.head.append(s);`);
        updateConfig({
          vite: {
            server: {
              proxy: {
                '/live-embed.js': studio,
                '/assets': studio,
                '/api': studio,
                '/occlude_core_bg.wasm': studio,
              },
            },
          },
        });
      },
    },
  };
}
