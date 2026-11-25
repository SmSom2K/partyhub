import { sharedConfig } from './shared-config.js';

const app = document.querySelector('#app');
const currentUrl = new URL(window.location.href);
const isInvitation = currentUrl.hash.startsWith('#invite=') ||
    currentUrl.searchParams.has('invite');

try {
    if (sharedConfig && (isInvitation || currentUrl.searchParams.get('demo') !== '1')) {
        const endpoint = new URL(sharedConfig.url);
        if (endpoint.protocol !== 'https:' ||
            !/^[a-z0-9-]+\.supabase\.co$/.test(endpoint.hostname) ||
            endpoint.href !== endpoint.origin + '/' ||
            !/^sb_publishable_[A-Za-z0-9_-]+$/.test(sharedConfig.publishableKey)) {
            throw new Error('Invalid shared workspace configuration.');
        }
        const { startShared } = await import('./shared.js');
        await startShared(sharedConfig);
    } else if (isInvitation) {
        app.innerHTML = '<main class="landing"><section class="card"><h1>Invitation unavailable</h1><p>The shared workspace is currently unavailable. Contact your host for help.</p></section></main>';
    } else {
        await import('./demo.js');
    }
} catch {
    app.innerHTML = '<main class="landing"><section class="card"><h1>PartyHub is unavailable</h1><p>Reload the page to try again.</p></section></main>';
}
