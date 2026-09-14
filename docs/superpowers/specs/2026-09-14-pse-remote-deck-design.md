# PSE Remote Deck Design

## Objective
Turn the existing iPad PSE Command Deck into a secure remote-control surface for the MacBook and its external monitor without requiring an App Store install.

## User experience
The installed PWA exposes three primary tabs: Monitor, Mac Remote, and Desktop. The existing ChatGPT mission composer remains available as a secondary Command tab rather than being removed.

## Monitor tab
The Monitor tab controls PSE Savage Ops Wall through its existing bounded command protocol. It shows live status including running state, external-display connection, current gallery, current artwork title/index, mode, visual state, and pause state.

Primary actions are Previous, Next, Pause/Resume, gallery selection, mode selection, visual-state selection, Reload Assets, and Restart Renderer. Actions must receive a success/failure response and refresh status immediately after execution.

## Mac Remote tab
The Mac Remote tab provides explicit, allowlisted Mac actions rather than arbitrary shell execution. Initial controls are display sleep/wake, volume up/down/mute, brightness up/down, media play/pause/next/previous, launch approved apps, switch to approved apps, restart approved PSE services, and refresh system status.

Live status includes AC/battery state, battery percentage, lid/clamshell state, current sleep policy, Desktop Commander health, Savage Ops Wall health, and selected PSE service health.
## Desktop tab
The Desktop tab embeds a browser-based remote desktop using noVNC. The transport path is Mac Screen Sharing/VNC -> websockify -> authenticated PSE gateway -> noVNC in the PWA.

Desktop access is independently enable/disable-able from the quick-control APIs. The noVNC session must use a separate authentication boundary so compromise of a quick-action endpoint does not grant unrestricted desktop access.

The Desktop tab must support touch pointer control, keyboard entry, scaling, fullscreen, clipboard where supported, and reconnection after transient network loss. Multi-monitor selection and file transfer are explicitly deferred from v1.

## Architecture
The iPad PWA is the presentation layer. It never receives arbitrary command execution capability.

A PSE control gateway exposes two bounded interfaces:
1. Monitor control/status, backed by the existing Savage Ops Wall command/status files.
2. Mac control/status, backed by a new local allowlisted Mac control service.

The full desktop path is separate from the quick-control API. noVNC connects only to a websockify endpoint that fronts the Mac VNC service. The gateway authenticates the user/session before allowing access to either control surface.

RustDesk is retained only as a fallback recovery path and is not a dependency of the PWA.

## Security model
No raw terminal, shell, AppleScript text box, or unrestricted process execution is exposed to the browser. Each Mac action maps to a fixed server-side handler with validated parameters.
Control requests require an authenticated session and CSRF-resistant request semantics. Sensitive control endpoints are not publicly callable without the PSE authentication layer.

The local Mac control service binds only to a private/local interface and does not expose itself directly to the public internet. The external gateway is the sole remote entry point.

Desktop credentials/tokens are never embedded in static PWA assets. Secrets remain server-side or in protected runtime configuration. Logs must avoid passwords, VNC credentials, cookies, bearer tokens, and clipboard contents.

## Failure handling
If the Mac is offline, quick controls show unavailable rather than hanging. If the wall renderer is offline, Monitor displays the last known state as stale and offers the bounded restart action.

If the noVNC transport is unavailable, Desktop presents a clear reconnect state and a RustDesk fallback note rather than silently switching protocols.

All destructive or disruptive actions such as restart service or renderer require an explicit button press. No automatic restart loop may repeatedly invoke user-facing applications.

## v1 scope
V1 includes the three control surfaces, authentication, bounded Mac actions, live status, noVNC desktop access, PWA installability, responsive iPad layout, and restart/network-recovery behavior.

Deferred: arbitrary terminal access, file manager, file transfer, multi-monitor remote desktop selection, macro scripting, automation recording, remote shutdown/reboot, and unrestricted app/process launching.

## Verification
Monitor controls must change the live Savage Ops Wall state and report the resulting status.
Mac quick controls must execute only allowlisted actions and reject malformed or unapproved requests.
Desktop must render the Mac screen and accept pointer/keyboard input from iPad Safari/PWA.
Clamshell mode must remain operational throughout testing: lid closed, Mac awake on AC, display allowed to sleep, Desktop Commander reachable, and remote-control services healthy.

A cold-start test must verify that all required services recover after reboot without exposing new public listeners.

## Definition of done
The iPad can open one installed PWA and:
- control what appears on the external monitor;
- perform the approved Mac quick controls;
- see current Mac/monitor health;
- open and control the live Mac desktop in-browser;
- recover from a temporary network interruption without manual Mac intervention.

The solution is not done if it requires the MacBook lid to remain open, requires an App Store install on the iPad, exposes arbitrary shell execution, or depends on an OpenAI API key.
