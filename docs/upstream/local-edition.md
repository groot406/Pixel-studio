# Pixel Studio — Local Codex edition

Draw and animate pixel art, then ask your own Codex to edit it inside the editor.
This edition runs on your computer and uses your Codex ChatGPT sign-in. Model
requests go to OpenAI and use your account's available allowance. There is no
shared Pixel Studio API key, automatic API-billing fallback, or hosted AI proxy.

## Start on your Mac

1. Install **Node.js 20 or newer** if needed: <https://nodejs.org/>.
2. Have the **Codex CLI** installed and signed in with ChatGPT. The desktop app
   alone does not guarantee that the `codex` command is available in Terminal.
   Check `codex --version` and `codex login status`.
3. Unzip the complete download into a folder you want to keep.
4. Double-click **Start-Pixel-Studio.command**, or open Terminal in that folder
   and run:

   ```sh
   npm start
   ```

No `npm install` is needed for Pixel Studio. The launcher opens
<http://127.0.0.1:4317/>. Leave its Terminal window running while you use AI edits;
press **Control-C** in Terminal to stop it. Drawing and editing remain available
when Codex is disconnected.

For Codex installation instructions, see
<https://learn.chatgpt.com/docs/codex/cli>. Use `codex login` to sign in with
ChatGPT if needed. If you normally use an API key, choose your desired Codex
sign-in deliberately before starting Pixel Studio; this edition accepts the
ChatGPT login method and reports other authentication methods without generating.

## Edit artwork

1. Open a saved project or import its `.pxa` / `.pxs` file.
2. Choose **AI edit** in the header or **Edit with AI** below the animation list.
3. Choose **Current frame**, **Current animation**, or **Whole project**.
4. Describe the edit. For example: "Add a subtle sparkle to the eyes, keep the
   character's silhouette and timing."
5. Check the Local Codex connection, choose an available model, and generate.
6. Compare the original and proposed artwork. Play the animation or inspect
   individual frames. Apply only the result you want; Undo restores the original.

Frame and animation edits preserve the other frames and animations. Canvas size,
animation structure, frame timing, and existing palette slots are retained.
New colors may be appended. Locked layer pixels are protected. Whole-project
edits may add layers and rearrange or rename editable layers. Existing layers
remain present, so an unwanted editable layer can be emptied and removed manually.

You can also **Copy edit prompt**, use it in ChatGPT yourself, then paste the
complete result into the same review dialog. Keep the edit completion comment
and any layer identity comments requested by the prompt. They help detect an
incomplete result and preserve the correct layers.

## Bring your current projects

The public website and localhost have separate browser storage. On the public
site, export your project as `.pxa` or `.pxs`, then import it into the local app.
Keep using the same address and port for the same local browser workspace.
PNG exports flatten layers; pixel data retains them.

## Troubleshooting

- **Codex not found:** install the CLI, reopen Terminal, and check `codex --version`.
- **Sign-in required:** run `codex login`, finish the browser flow, and use
  **Refresh connection** in Pixel Studio.
- **Another authentication method:** check `codex login status`; Pixel Studio
  requires ChatGPT sign-in for this local edition.
- **Usage limit or model unavailable:** the error is shown without applying an
  edit. Choose another available model or wait for your account's allowance.
- **Incomplete or invalid result:** the original project is kept. Retry the
  request or use a smaller scope, such as one animation or frame.
- **Port in use:** stop the other Pixel Studio launcher or start with
  `node local/start.mjs --port 4318 --open`.
- **Open page but disconnected:** keep the local launcher running and refresh
  the connection. Opening `dist/index.html` directly does not start the service.

## How the local connection works

The Node service serves `dist/` and communicates with `codex app-server` over
standard input/output. It binds to loopback, requires same-origin requests and
a session token for generation, checks the ChatGPT login method, and constrains
Codex to a temporary read-only workspace. Browser requests cannot supply shell
commands, provider URLs, credentials, or working directories. Closing or
canceling a request stops its local generation session.

The public Pixel Studio website does not connect to your local service. It
offers this download and the copy/paste review workflow. A hosted service using
visitors' ChatGPT plans requires a separate approved Sign in with ChatGPT
integration. OpenAI recommends that flow for distributed integrations:
<https://developers.openai.com/siwc/token-sharing-open-source>.

Official Codex app-server and authentication documentation:

- <https://learn.chatgpt.com/docs/app-server>
- <https://learn.chatgpt.com/docs/auth>
