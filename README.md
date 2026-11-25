# PartyHub

The public GitHub Pages site serves a browser-local demo until a Supabase project is connected. The demo stores event details in local storage and media in IndexedDB.

## Enable shared events

1. Create a Supabase project and apply both SQL migrations in `supabase/migrations` in filename order.
2. In Supabase Auth, enable email sign-in and set the site URL to `https://smsom2k.github.io/partyhub/`. Add that same URL to the allowed redirect list.
3. Configure a dedicated SMTP sender before opening host sign-ups to the public. The default sender can deliver to project team addresses for initial verification.
4. In `shared-config.js`, set `sharedConfig` to an object with the Supabase project `url` and `publishableKey`. The publishable key is intended for the browser. Keep Supabase secret and service-role keys in the provider dashboard or server-side secret storage.
5. Publish the web files on the GitHub Pages branch. Verify host sign-in and use an invitation in a separate browser profile to confirm that the RSVP updates only the matching household.

The existing local demo remains available at `?demo=1` after connecting the backend. Export the demo JSON from Settings, then import that file from the Event tab of a signed-in, empty workspace. The export contains guest information. Keep it private. Album files and invitation links are excluded.

Household links expire after 180 days. Creating a fresh link replaces the previous link. The workspace supports one host account and its own private album.

## Install PartyHub

Open the HTTPS site and use your browser's Install app or Add to Home Screen command. Shared event features require a connection.

## Update the bundled client

Run `npm ci` and `npm run vendor` with Node.js 22 or later. Commit the updated lockfile, bundle, and notices when updating dependencies. GitHub Pages serves the checked-in bundle and needs no build or external script CDN.

## Local preview

Run `python -m http.server 8766 --bind 127.0.0.1` in the project directory and open `http://127.0.0.1:8766/`.
