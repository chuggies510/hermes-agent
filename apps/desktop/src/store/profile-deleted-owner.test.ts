import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveLaunchProfile } from '../../electron/primary-profile-pin'
import { deferred } from '../test/deferred'

// A profile deleted or renamed outside this window (the CLI, another window)
// must stop owning the foreground once the active source's authoritative
// profile list omits it. Real stores throughout: only the WebSocket transport
// and the Electron IPC bridge are faked. The bridge keeps active-profile.json's
// two fields in memory; electron/desktop-profile.test.ts proves the real store
// persists what this writes.

const sockets: Array<{ close: ReturnType<typeof vi.fn> }> = []
const dial = { fail: false, gate: null as null | Promise<void>, release: () => {} }

vi.mock('@/hermes', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()

  return {
    ...actual,
    HermesGateway: class {
      connectionState = 'closed'
      connect = vi.fn(async () => {
        await dial.gate

        if (dial.fail) {
          throw new Error('unreachable')
        }

        this.connectionState = 'open'
      })
      request = vi.fn(async () => ({}))
      close = vi.fn()
      onEvent = vi.fn(() => () => {})
      onState = vi.fn(() => () => {})

      constructor() {
        sockets.push(this)
      }
    }
  }
})

const gateway = await import('@/store/gateway')
const profile = await import('@/store/profile')
const composer = await import('@/store/composer')
const { startWorkspaceSession } = await import('@/app/session/workspace-session-target')
const { defaultNewSessionTarget } = await import('@/app/session/new-session-route')
const { $defaultProfileRoute } = await import('@/store/default-profile')
const { setConnection } = await import('@/store/session')

const {
  $activeGatewayProfile,
  $gatewaySwapTarget,
  $newChatConnectionId,
  $newChatProfile,
  $newChatRoute,
  ensureGatewayAgent,
  refreshActiveProfile,
  refreshProfiles,
  resolveActiveSourceOwnerRoute,
  resolveNewChatOwnerRoute
} = profile

const listed = (...names: string[]) => ({
  profiles: names.map(name => ({ is_default: name === 'default', name }))
})

const api = vi.fn()

const prefs = {
  defaultRoute: null as null | { connectionId: null | string; profile: string },
  profile: null as null | string
}

const launch = () => resolveLaunchProfile(() => prefs.profile)

// Whether a remote source shares one backend, and which profiles carry a
// per-profile connection override (their name is a client-side alias).
const remote = { configGate: null as null | Promise<void>, overridden: new Set<string>(), shared: false }

const remember = vi.fn(async (name: null | string) => {
  prefs.profile = name

  return { profile: name }
})

function installDesktop(): void {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    writable: true,
    value: {
      api,
      getConnection: vi.fn(async (name?: string) => ({ baseUrl: '', mode: 'local', profile: name ?? 'default' })),
      getConnectionConfig: vi.fn(async (name: string) => {
        await remote.configGate

        return { mode: remote.overridden.has(name) ? 'remote' : 'local' }
      }),
      getConnectionFor: vi.fn(async ({ connectionId, profile: name }: { connectionId: string; profile: string }) => ({
        baseUrl: '',
        connectionId,
        mode: connectionId === 'local' ? 'local' : 'remote',
        profile: name,
        registryScoped: true,
        sharedRemote: connectionId !== 'local' && remote.shared
      })),
      profile: {
        get: vi.fn(async () => ({ profile: prefs.profile })),
        getDefault: vi.fn(async () => prefs.defaultRoute),
        remember
      },
      touchBackend: vi.fn(async () => undefined)
    }
  })
}

// The same mirrors use-gateway-boot wires: the registry owns the route and
// the profile atom follows it.
function configureLikeBoot(): void {
  gateway.configureGatewayRegistry({
    onActiveConnectionInvalidated: fallback => $activeGatewayProfile.set(fallback),
    onActiveRouteChanged: name => $activeGatewayProfile.set(name),
    onEvent: vi.fn()
  })
}

async function activateStale(connectionId: string, name = 'execassistant'): Promise<void> {
  await ensureGatewayAgent(connectionId, name)
  expect(gateway.activeGatewayConnectionId()).toBe(connectionId)
  expect($activeGatewayProfile.get()).toBe(name)
}

function draftOn(connectionId: string, name = 'execassistant'): void {
  $newChatProfile.set(name)
  $newChatRoute.set({ connectionId, profile: name })
  $newChatConnectionId.set(connectionId)
}

// Lists that prove nothing about which profiles a source serves.
const unprovingLists = [
  ['a failed list', () => api.mockRejectedValue(new Error('offline'))],
  ['an empty list', () => api.mockResolvedValue(listed())],
  ['a list without the default profile', () => api.mockResolvedValue(listed('exec'))]
] as const

// Refresh through the retry backoff without waiting on real timers.
async function refreshSettled(): Promise<void> {
  vi.useFakeTimers()

  try {
    const flight = refreshProfiles().catch(() => undefined)
    await vi.runAllTimersAsync()
    await flight
  } finally {
    vi.useRealTimers()
  }
}

function homePlus(): void {
  startWorkspaceSession({
    activeSessionIdRef: { current: null },
    path: null,
    requestGateway: vi.fn(),
    startFreshSessionDraft: vi.fn()
  })
}

beforeEach(async () => {
  sockets.length = 0
  api.mockReset()
  remember.mockClear()
  Object.assign(dial, { fail: false, gate: null, release: () => {} })
  Object.assign(remote, { configGate: null, overridden: new Set(), shared: false })
  Object.assign(prefs, { defaultRoute: null, profile: null })
  installDesktop()
  configureLikeBoot()
  gateway.closeSecondaryGateways()
  gateway.setPrimaryGateway({ connectionState: 'open', request: vi.fn() } as never, 'default')
  gateway.setPrimaryGatewayConnection({ connectionId: 'local', mode: 'local' })
  $activeGatewayProfile.set('default')
  $newChatProfile.set(null)
  $newChatRoute.set(null)
  $newChatConnectionId.set(null)
  $defaultProfileRoute.set(null)
  // Earlier cases leave authoritative lists and retirements behind; each case
  // starts clean.
  profile.invalidateProfileListFetches()
  profile.$profilesByConnection.set(new Map())

  for (const id of ['local', 'mac-mini', 'homelab']) {
    profile.forgetRetiredProfilesForConnection(id)
  }

  await Promise.resolve()
})

afterEach(() => {
  // A case that fails mid-dial must not hold the switch mutex for the next.
  dial.release()
  gateway.closeSecondaryGateways()
  window.history.replaceState(null, '', '/')
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('an active profile the authoritative list no longer serves', () => {
  it('Home "+" pins a live profile instead of the deleted foreground owner', async () => {
    await activateStale('local')
    draftOn('local')
    composer.setComposerDraft('half-typed thought')
    const freshKey = composer.$freshDraftKey.get()
    api.mockResolvedValue(listed('default', 'exec'))

    await refreshProfiles()
    homePlus()

    expect($activeGatewayProfile.get()).toBe('default')
    expect(gateway.activeGatewayConnectionId()).toBe('local')
    expect($newChatProfile.get()).toBe('default')
    expect(resolveNewChatOwnerRoute()).toEqual({ connectionId: 'local', profile: 'default' })
    // The fallback is a re-home, not a teardown: no socket closed, and the
    // user's composer and fresh-draft identity are untouched.
    expect(sockets.every(socket => socket.close.mock.calls.length === 0)).toBe(true)
    expect(composer.$composerDraft.get()).toBe('half-typed thought')
    expect(composer.$freshDraftKey.get()).toBe(freshKey)
  })

  it('never lets one source retire a same-named profile on another source', async () => {
    await activateStale('local')
    draftOn('homelab')
    api.mockResolvedValue(listed('default', 'exec'))

    await refreshProfiles()

    expect($activeGatewayProfile.get()).toBe('default')
    expect(resolveNewChatOwnerRoute()).toEqual({ connectionId: 'homelab', profile: 'execassistant' })
  })

  it.each(unprovingLists)('keeps the owner after %s', async (_label, respond) => {
    await activateStale('local')
    draftOn('local')
    respond()

    await refreshSettled()

    expect($activeGatewayProfile.get()).toBe('execassistant')
    expect(resolveNewChatOwnerRoute()).toEqual({ connectionId: 'local', profile: 'execassistant' })
  })

  it.each([
    ['the active profile moved', () => $activeGatewayProfile.set('exec')],
    ['a gateway swap is in flight', () => $gatewaySwapTarget.set('exec')]
  ])('ignores a list that resolves after %s', async (_label, interleave) => {
    await activateStale('local')
    draftOn('local')
    const response = deferred<ReturnType<typeof listed>>()
    api.mockReturnValue(response.promise)

    const flight = refreshProfiles()
    interleave()
    response.resolve(listed('default', 'exec'))
    await flight
    $gatewaySwapTarget.set(null)

    expect(resolveNewChatOwnerRoute()).toEqual({ connectionId: 'local', profile: 'execassistant' })
    expect(gateway.activeGatewayProfileKey()).toBe('execassistant')
  })

  it('does not restore a saved default route that names the deleted profile', async () => {
    await activateStale('local')
    api.mockResolvedValue(listed('default', 'exec'))
    await refreshProfiles()

    $defaultProfileRoute.set({ connectionId: 'local', profile: 'execassistant' })
    expect(defaultNewSessionTarget()).toBeNull()

    $defaultProfileRoute.set({ connectionId: 'local', profile: 'exec' })
    expect(defaultNewSessionTarget()?.profile).toBe('exec')
  })

  it('leaves a listed active profile and its draft alone', async () => {
    await activateStale('local', 'exec')
    draftOn('local', 'exec')
    api.mockResolvedValue(listed('default', 'exec'))

    await refreshProfiles()

    expect($activeGatewayProfile.get()).toBe('exec')
    expect(resolveNewChatOwnerRoute()).toEqual({ connectionId: 'local', profile: 'exec' })
  })
})

// A retirement is a claim about one registry entry's backend at one moment.
// It must not outlive that backend or the profile's absence.
describe('a retired owner', () => {
  const deletedRoute = { connectionId: 'local', profile: 'execassistant' }

  async function retire(): Promise<void> {
    await activateStale('local')
    api.mockResolvedValue(listed('default', 'exec'))
    await refreshProfiles()
    $defaultProfileRoute.set(deletedRoute)
    draftOn('local')
    expect(defaultNewSessionTarget()).toBeNull()
    expect(resolveNewChatOwnerRoute()).toEqual({ connectionId: 'local', profile: 'default' })
  }

  it('is forgotten when its registry entry is edited to another backend or removed', async () => {
    await retire()

    // The registry-change handler (use-gateway-boot) runs this for both.
    profile.forgetRetiredProfilesForConnection('local')

    expect(defaultNewSessionTarget()).toEqual({ profile: 'execassistant', route: deletedRoute })
    expect(resolveNewChatOwnerRoute()).toEqual(deletedRoute)
  })

  it('is revived when its source lists the profile again', async () => {
    await retire()
    api.mockResolvedValue(listed('default', 'exec', 'execassistant'))
    profile.invalidateProfileListFetches()

    await refreshProfiles()

    expect(defaultNewSessionTarget()).toEqual({ profile: 'execassistant', route: deletedRoute })
    expect(resolveNewChatOwnerRoute()).toEqual(deletedRoute)
  })
})

// The MacBook case: the window PRIMARY itself is a remote source's profile
// that was deleted there (active-profile.json {profile: execassistant},
// primary connection mac-mini, no default route). No exact-scope secondary
// exists to fall back from, so the primary's own source must re-home the
// foreground to its Default, on the SAME connection.
describe('a primary profile its own source no longer serves', () => {
  const primary = { close: vi.fn(), connectionState: 'open', request: vi.fn() }
  const home = { connectionId: 'mac-mini', profile: 'default' }

  function bootPrimary(connectionId = 'mac-mini', name = 'execassistant', descriptor: object = {}): void {
    primary.close.mockClear()
    gateway.setPrimaryGateway(primary as never, name)
    gateway.setPrimaryGatewayConnection({ connectionId, mode: 'remote' })
    $activeGatewayProfile.set(name)
    setConnection({ baseUrl: '', connectionId, mode: 'remote', profile: name, ...descriptor } as never)
    prefs.profile = name
    expect(gateway.isActivePrimary()).toBe(true)
    expect(gateway.activeGatewayConnectionId()).toBe(connectionId)
  }

  // The re-home is fire-and-forget from the list; give it every tick it needs.
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))

  function expectUntouched(): void {
    expect($activeGatewayProfile.get()).toBe('execassistant')
    expect(gateway.isActivePrimary()).toBe(true)
    expect(gateway.activeGatewayConnectionId()).toBe('mac-mini')
    expect(remember).not.toHaveBeenCalled()
    expect(launch().argvProfile).toBe('execassistant')
  }

  // The next launch boots the primary with no --profile pin, like a fresh
  // install, rather than pinning `--profile default` (profile-migration.ts).
  function expectLaunchForgotten(): void {
    expect(remember.mock.calls).toEqual([[null]])
    expect(launch()).toEqual({ argvProfile: null, routingProfile: 'default' })
  }

  it.each([
    ['an isolated remote', false],
    ['a shared remote', true]
  ])('re-homes to Default on the same connection (%s) and persists it', async (_label, shared) => {
    remote.shared = shared
    bootPrimary()
    api.mockResolvedValue(listed('default', 'exec'))

    await refreshProfiles()
    await vi.waitFor(() => expect($activeGatewayProfile.get()).toBe('default'))
    await settle()

    expect(gateway.activeGatewayConnectionId()).toBe('mac-mini')
    expect(resolveNewChatOwnerRoute()).toEqual(home)
    // A re-home, never a teardown: the primary keeps its socket (and every
    // submitted write riding it), and no other socket closes either.
    expect(primary.close).not.toHaveBeenCalled()
    expect(sockets.every(socket => socket.close.mock.calls.length === 0)).toBe(true)
    expectLaunchForgotten()
  })

  it('re-homes during boot, from the profile refresh boot runs after adopting the primary', async () => {
    bootPrimary()
    api.mockImplementation(async ({ path: route }: { path: string }) =>
      route === '/api/profiles/active' ? { active: 'default', current: 'default' } : listed('default', 'exec')
    )

    await refreshActiveProfile()
    await vi.waitFor(() => expect($activeGatewayProfile.get()).toBe('default'))
    await settle()

    expect(gateway.activeGatewayConnectionId()).toBe('mac-mini')
    expectLaunchForgotten()
  })

  it('routes Home "+" and Send to Default while the re-home is still dialing, and after it lands', async () => {
    const socket = deferred()
    Object.assign(dial, { gate: socket.promise, release: socket.resolve })
    bootPrimary()
    api.mockResolvedValue(listed('default', 'exec'))

    await refreshProfiles()
    await vi.waitFor(() => expect($gatewaySwapTarget.get()).toBe('default'))
    expect($activeGatewayProfile.get()).toBe('execassistant')

    // Send with no pin, Home "+" (which pins the still-painted owner), and a
    // project tile all resolve the source's Default, never the deleted name.
    expect(resolveNewChatOwnerRoute()).toEqual(home)
    homePlus()
    expect(resolveNewChatOwnerRoute()).toEqual(home)
    expect(resolveActiveSourceOwnerRoute('execassistant')).toEqual(home)

    socket.resolve()
    await vi.waitFor(() => expect($activeGatewayProfile.get()).toBe('default'))
    await settle()

    expect(resolveNewChatOwnerRoute()).toEqual(home)
    homePlus()
    expect(resolveNewChatOwnerRoute()).toEqual(home)
  })

  it('recovers the same source Default when a secondary falls back to a primary that is gone too', async () => {
    bootPrimary()
    await activateStale('mac-mini', 'oldbot')
    api.mockResolvedValue(listed('default', 'exec'))

    await refreshProfiles()
    await vi.waitFor(() => expect($activeGatewayProfile.get()).toBe('default'))
    await settle()

    expect(gateway.activeGatewayConnectionId()).toBe('mac-mini')
    expect(resolveNewChatOwnerRoute()).toEqual(home)
    expect(primary.close).not.toHaveBeenCalled()
  })

  it('never overwrites a startup preference that names another profile', async () => {
    bootPrimary()
    prefs.profile = 'exec'
    api.mockResolvedValue(listed('default', 'exec'))

    await refreshProfiles()
    await vi.waitFor(() => expect($activeGatewayProfile.get()).toBe('default'))
    await settle()

    expect(remember).not.toHaveBeenCalled()
    expect(launch().argvProfile).toBe('exec')
  })

  it('leaves the legacy preference alone while an explicit default route decides launch', async () => {
    bootPrimary()
    prefs.defaultRoute = { connectionId: 'mac-mini', profile: 'execassistant' }
    api.mockResolvedValue(listed('default', 'exec'))

    await refreshProfiles()
    await vi.waitFor(() => expect($activeGatewayProfile.get()).toBe('default'))
    await settle()

    expect(remember).not.toHaveBeenCalled()
    expect(launch().argvProfile).toBe('execassistant')
  })

  // The legacy preference names a profile on the source the preference
  // launches. A primary this window reached another way proves nothing about
  // it, even under the same name (a local `execassistant` may still exist).
  it.each([
    ['launched on an explicit registry route', () => bootPrimary('mac-mini', 'execassistant', { registryScoped: true })],
    [
      'pinned to this window',
      () => {
        window.history.replaceState(null, '', '/?profile=execassistant&connectionId=mac-mini&profileWindow=1')
        bootPrimary()
      }
    ]
  ])('re-homes a primary %s without touching the startup preference', async (_label, boot) => {
    boot()
    api.mockResolvedValue(listed('default', 'exec'))

    await refreshProfiles()
    await vi.waitFor(() => expect($activeGatewayProfile.get()).toBe('default'))
    await settle()

    expect(gateway.activeGatewayConnectionId()).toBe('mac-mini')
    expect(remember).not.toHaveBeenCalled()
    expect(launch().argvProfile).toBe('execassistant')
  })

  it('treats a per-profile connection override name as an alias, not a missing profile', async () => {
    remote.overridden.add('execassistant')
    bootPrimary()
    api.mockResolvedValue(listed('default', 'exec'))

    await refreshProfiles()
    await settle()

    expectUntouched()
    expect(resolveNewChatOwnerRoute()).toEqual({ connectionId: 'mac-mini', profile: 'execassistant' })
  })

  it('yields to a switch the user makes while the alias check is pending', async () => {
    const config = deferred()
    remote.configGate = config.promise
    bootPrimary()
    api.mockResolvedValue(listed('default', 'exec'))

    await refreshProfiles()
    await activateStale('mac-mini', 'exec')
    config.resolve()
    await settle()

    expect($activeGatewayProfile.get()).toBe('exec')
    expect(remember).not.toHaveBeenCalled()
    expect(launch().argvProfile).toBe('execassistant')
  })

  it.each(unprovingLists)('changes nothing after %s', async (_label, respond) => {
    bootPrimary()
    respond()

    await refreshSettled()
    await settle()
    expectUntouched()
  })

  it.each([
    // Same (connection, profile) afterwards, but a real activation ran in
    // between: an A->B->A flip must not pass as the route the list was for.
    ['the route was re-activated mid-flight', () => gateway.ensureGatewayForProfile('execassistant')],
    ['a gateway swap is in flight', async () => $gatewaySwapTarget.set('exec')]
  ])('ignores a list when %s', async (_label, interleave) => {
    bootPrimary()
    const response = deferred<ReturnType<typeof listed>>()
    api.mockReturnValue(response.promise)

    const flight = refreshProfiles()
    await interleave()
    response.resolve(listed('default', 'exec'))
    await flight
    $gatewaySwapTarget.set(null)
    await settle()

    expectUntouched()
  })

  it('ignores a list requested while the descriptor names another source', async () => {
    bootPrimary()
    setConnection({ baseUrl: '', connectionId: 'homelab', mode: 'remote' } as never)
    api.mockResolvedValue(listed('default', 'exec'))

    await refreshProfiles()
    await settle()

    expectUntouched()
  })

  it('keeps the startup preference when the Default activation does not land', async () => {
    bootPrimary()
    dial.fail = true
    api.mockResolvedValue(listed('default', 'exec'))

    await refreshProfiles()
    await vi.waitFor(() => expect($gatewaySwapTarget.get()).toBeNull())
    await settle()

    expectUntouched()
  })

  it('activates Default once across rapid refreshes', async () => {
    bootPrimary()
    api.mockResolvedValue(listed('default', 'exec'))
    const swaps: Array<null | string> = []
    const stop = $gatewaySwapTarget.listen(target => void swaps.push(target))

    await refreshProfiles()
    profile.invalidateProfileListFetches()
    await refreshProfiles()
    await vi.waitFor(() => expect($activeGatewayProfile.get()).toBe('default'))
    await settle()

    stop()

    expect(swaps.filter(target => target === 'default')).toHaveLength(1)
    expectLaunchForgotten()
  })

  it('leaves a listed primary alone', async () => {
    bootPrimary('mac-mini', 'exec')
    api.mockResolvedValue(listed('default', 'exec'))

    await refreshProfiles()
    await settle()

    expect($activeGatewayProfile.get()).toBe('exec')
    expect(gateway.isActivePrimary()).toBe(true)
    expect(remember).not.toHaveBeenCalled()
  })
})
