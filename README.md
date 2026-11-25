# PartyHub

The public GitHub Pages site serves a browser-local demo until a Supabase project is connected. The demo stores event details in local storage and media in IndexedDB.

## Enable shared events

1. Create a Supabase project and apply the SQL migration in `supabase/migrations`.
2. In Supabase Auth, enable email sign-in and set the site URL to `https://smsom2k.github.io/partyhub/`. Add that same URL to the allowed redirect list.
3. Configure a dedicated SMTP sender before opening host sign-ups to the public. The default sender can deliver to project team addresses for initial verification.
4. In `shared-config.js`, set `sharedConfig` to an object with the Supabase project `url` and `publishableKey`. The publishable key is intended for the browser. Keep Supabase secret and service-role keys in the provider dashboard or server-side secret storage.
5. Publish the web files on the GitHub Pages branch. Verify host sign-in and use an invitation in a separate browser profile to confirm that the RSVP updates only the matching household.

The existing local demo remains available at `?demo=1` after connecting the backend. Demo data stays in that browser. Use Settings to export a copy.

## Local preview

Run `python -m http.server 8765 --bind 127.0.0.1` in the project directory and open `http://127.0.0.1:8765/`.
