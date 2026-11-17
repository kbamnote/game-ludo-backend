/**
 * Privacy policy served at /privacy.
 *
 * Play Console requires a publicly reachable policy URL and a Data Safety
 * declaration that matches it, so this describes exactly what the app does
 * today: a generated device id and a chosen nickname, held in memory only.
 * If the app ever gains analytics, ads, accounts or a database, this text has
 * to change with it.
 */

const APP_NAME = 'CGP - Cockroach Game Party'
const UPDATED = '17 November 2026'

/** Overridable with CONTACT_EMAIL in the Railway service variables. */
const CONTACT = process.env.CONTACT_EMAIL ?? 'kunalbamnote7@gmail.com'

export function privacyHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — ${APP_NAME}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 20px 64px;
    background: linear-gradient(180deg, #2566c4 0%, #1649a0 45%, #0b2558 100%);
    background-attachment: fixed;
    color: #eaf1ff;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 720px; margin: 0 auto; }
  .card {
    background: rgba(5, 20, 56, 0.72);
    border: 1px solid rgba(120, 170, 255, 0.28);
    border-radius: 16px;
    padding: 28px;
  }
  h1 { margin: 0 0 4px; font-size: 28px; color: #ffc62e; letter-spacing: -0.01em; }
  .updated { margin: 0 0 24px; font-size: 13px; color: #a8c2ee; }
  h2 { margin: 30px 0 8px; font-size: 18px; color: #ffe587; }
  h2:first-of-type { margin-top: 8px; }
  p, li { color: #dbe7ff; }
  ul { padding-left: 20px; }
  li { margin: 5px 0; }
  code { background: rgba(0,0,0,0.3); padding: 1px 6px; border-radius: 5px; font-size: 14px; }
  .note {
    margin-top: 28px; padding: 14px 16px;
    background: rgba(255, 198, 46, 0.12);
    border-left: 3px solid #ffc62e;
    border-radius: 8px; font-size: 14.5px;
  }
  a { color: #8ec3ff; }
  footer { margin-top: 26px; font-size: 13px; color: #9fb8e4; }
</style>
</head>
<body>
<main>
  <div class="card">
    <h1>Privacy Policy</h1>
    <p class="updated">${APP_NAME} · Last updated ${UPDATED}</p>

    <p>
      This policy explains what ${APP_NAME} collects and why. In short: the game asks for a
      nickname so other players can tell you apart, and nothing else. There are no accounts,
      no advertising, and no analytics or tracking software in the app.
    </p>

    <h2>What the app collects</h2>
    <ul>
      <li>
        <strong>A device identifier.</strong> The first time you open the app it generates a
        random id (for example <code>p_m1x2y3_ab12cd34</code>). It is created on your device,
        is not derived from your hardware, phone number, advertising id or any account, and
        cannot be used to identify you personally.
      </li>
      <li>
        <strong>A nickname.</strong> Whatever you type. It is shown to the other players in a
        room. Please do not use your full name or any personal detail you would not want other
        players to see.
      </li>
      <li>
        <strong>Gameplay actions while you are in an online room.</strong> Room codes, dice
        rolls and piece moves, so the server can referee the match.
      </li>
    </ul>

    <h2>What the app does not collect</h2>
    <p>
      No name, email address, phone number, date of birth, location, contacts, photos,
      microphone or camera data, and no payment information. The app contains no advertising
      network, no analytics and no crash-reporting service.
    </p>

    <h2>Information kept on your device only</h2>
    <p>
      Your in-game progress — coins, gems, level and reward timers — is stored on your device
      and is never sent anywhere. Uninstalling the app deletes it permanently.
    </p>

    <h2>How long the server keeps anything</h2>
    <p>
      Rooms exist only in the server's memory. There is no database and nothing is written to
      disk. A room is discarded once it has been empty for 30 minutes, and every room is lost
      whenever the server restarts. Your nickname and device id live only inside the room you
      are in and disappear with it.
    </p>

    <h2>Server logs</h2>
    <p>
      Like any internet service, the server and its hosting provider (Railway) process the
      network connection itself, which includes your IP address, in order to deliver the
      traffic and guard against abuse. We do not combine this with your nickname or build
      profiles from it.
    </p>

    <h2>Who else receives your information</h2>
    <p>
      Nobody. Your nickname is visible to the other players in your room, which is the point
      of it. Beyond that, information is not sold, rented or shared with third parties. The
      only external company involved is Railway, which hosts the server.
    </p>

    <h2>Children</h2>
    <p>
      ${APP_NAME} is not directed at children under 13 and we do not knowingly collect
      information from them. If you believe a child has provided information, contact us and
      we will remove it.
    </p>

    <h2>Your choices</h2>
    <ul>
      <li>Change your nickname at any time on the Play with Friends screen.</li>
      <li>Play offline — the single-player and pass-and-play modes send nothing to any server.</li>
      <li>Uninstall the app to erase everything stored on your device.</li>
      <li>Ask us to delete anything associated with your device id, using the contact below.</li>
    </ul>

    <h2>Security</h2>
    <p>
      All traffic between the app and the server uses encrypted HTTPS and WSS connections.
    </p>

    <h2>Changes</h2>
    <p>
      If this policy changes, the date at the top of this page changes with it. Material
      changes will be announced in the app.
    </p>

    <h2>Contact</h2>
    <p>Questions about this policy: <a href="mailto:${CONTACT}">${CONTACT}</a></p>

    <div class="note">
      <strong>Template notice.</strong> This policy was drafted to match the app's actual
      behaviour, but it is not legal advice. Have it reviewed before you rely on it, and keep
      it in step with your Play Console Data Safety answers if the app's behaviour changes.
    </div>

    <footer>© ${new Date().getFullYear()} ${APP_NAME}</footer>
  </div>
</main>
</body>
</html>`
}
