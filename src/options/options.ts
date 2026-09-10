/** Options page: edit the gated hostname list and keep host permissions in step with it. */
import {
  DEFAULT_HOSTNAMES,
  getHostnames,
  matchPattern,
  matchPatterns,
  parseHostnameList,
  setHostnames,
} from '../common/config';

const textarea = document.getElementById('hostnames') as HTMLTextAreaElement;
const saveButton = document.getElementById('save') as HTMLButtonElement;
const resetButton = document.getElementById('reset') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLParagraphElement;
const permissionList = document.getElementById('permissions') as HTMLUListElement;

function setStatus(message: string, tone: 'ok' | 'warn' | 'error' | '' = ''): void {
  status.textContent = message;
  status.className = tone;
}

async function renderPermissions(hostnames: readonly string[]): Promise<void> {
  permissionList.replaceChildren();
  for (const hostname of hostnames) {
    const pattern = matchPattern(hostname);
    let granted = false;
    try {
      granted = await chrome.permissions.contains({ origins: [pattern] });
    } catch {
      granted = false;
    }

    const item = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = pattern;
    const tag = document.createElement('span');
    tag.className = `tag ${granted ? 'granted' : 'missing'}`;
    tag.textContent = granted ? 'granted' : 'not granted — save to allow';
    item.append(code, tag);
    permissionList.append(item);
  }
}

async function load(): Promise<void> {
  const hostnames = await getHostnames();
  textarea.value = hostnames.join('\n');
  await renderPermissions(hostnames);
}

/** Hands back access to hosts that are no longer on the list. */
async function dropStalePermissions(keep: readonly string[]): Promise<void> {
  const keepPatterns = new Set(matchPatterns(keep));
  let current: chrome.permissions.Permissions;
  try {
    current = await chrome.permissions.getAll();
  } catch {
    return;
  }
  const stale = (current.origins ?? []).filter((origin) => !keepPatterns.has(origin));
  if (stale.length === 0) return;
  // Origins declared in the manifest cannot be revoked; that rejection is fine.
  await chrome.permissions.remove({ origins: stale }).catch(() => undefined);
}

saveButton.addEventListener('click', () => {
  const hostnames = parseHostnameList(textarea.value);
  if (hostnames.length === 0) {
    setStatus('Add at least one hostname, or restore the defaults.', 'error');
    return;
  }

  // permissions.request must be the first thing the click does: any await
  // before it loses the user gesture and Chrome rejects the prompt.
  const request = chrome.permissions.request({ origins: matchPatterns(hostnames) });

  void (async () => {
    let granted = false;
    try {
      granted = await request;
    } catch (error) {
      setStatus(`Chrome refused the permission request: ${String(error)}`, 'error');
      return;
    }

    await setHostnames(hostnames);
    await dropStalePermissions(hostnames);
    textarea.value = hostnames.join('\n');
    await renderPermissions(hostnames);

    if (granted) {
      setStatus(`Saved. Gating ${hostnames.length} host${hostnames.length === 1 ? '' : 's'}.`, 'ok');
    } else {
      setStatus(
        'Saved, but Chrome did not grant access to every host — the ones marked below will not be gated.',
        'warn',
      );
    }
  })();
});

resetButton.addEventListener('click', () => {
  textarea.value = [...DEFAULT_HOSTNAMES].join('\n');
  setStatus('Defaults restored in the box — click Save to apply them.', 'warn');
});

void load();
