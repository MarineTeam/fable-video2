import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isValidVideoGuid, resolvePublicAccess, toPublicGuidSet } from '../publicVideos';

const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// Mocks are hoisted, so they live at module top level where their execution
// order is honest. The route's own logic module is imported below; the page
// file is JSX and cannot be imported by the runner.
const spies = vi.hoisted(() => ({
  isVideoPublic: vi.fn(async () => false),
  getVideoWindow: vi.fn(async () => null),
  getVideo: vi.fn(async () => ({
    guid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    title: 'A talk',
    length: 60,
  })),
}));

vi.mock('../publicVideosStore', () => ({
  isVideoPublic: spies.isVideoPublic,
  loadPublicVideoGuids: vi.fn(async () => new Set()),
  setVideoPublic: vi.fn(),
  clearVideoPublic: vi.fn(),
}));
vi.mock('../scheduleStore', () => ({
  getVideoWindow: spies.getVideoWindow,
  loadSchedule: vi.fn(async () => ({})),
  setVideoWindow: vi.fn(),
  clearVideoWindow: vi.fn(),
}));
vi.mock('../bunny', () => ({
  getVideo: spies.getVideo,
  signedEmbedUrl: () => 'https://iframe.example/embed?token=signed&expires=1',
  thumbnailUrl: () => null,
  isPlayable: () => true,
}));
vi.mock('../chaptersStore', () => ({ getVideoChapters: vi.fn(async () => []) }));
vi.mock('../notesStore', () => ({ getVideoNotes: vi.fn(async () => null) }));
vi.mock('../siteNameStore', () => ({ getSiteName: vi.fn(async () => 'Test Portal') }));
vi.mock('../geo', () => ({ isGeoAllowed: vi.fn(async () => true) }));


describe('isValidVideoGuid', () => {
  it('accepts a bunny guid and rejects anything else', () => {
    expect(isValidVideoGuid(GUID)).toBe(true);
    expect(isValidVideoGuid('../../etc/passwd')).toBe(false);
    expect(isValidVideoGuid('short')).toBe(false);
    expect(isValidVideoGuid('')).toBe(false);
    expect(isValidVideoGuid(null)).toBe(false);
    expect(isValidVideoGuid('z'.repeat(20))).toBe(false);
  });
});

describe('resolvePublicAccess', () => {
  // The founding rule: absence is never permission.
  it('denies by default', () => {
    expect(resolvePublicAccess({}).allowed).toBe(false);
    expect(resolvePublicAccess({ isPublic: false }).allowed).toBe(false);
    expect(resolvePublicAccess({ isPublic: undefined }).allowed).toBe(false);
    expect(resolvePublicAccess().allowed).toBe(false);
  });

  it('allows a public video with no publish window', () => {
    expect(resolvePublicAccess({ isPublic: true, window: null }).allowed).toBe(true);
  });

  // Ticking "public" must not smuggle a video out ahead of its schedule.
  it('still applies the publish window', () => {
    const now = Date.parse('2026-06-15T12:00:00Z');
    expect(
      resolvePublicAccess({ isPublic: true, window: { from: '2026-07-01T00:00:00Z' }, now })
    ).toMatchObject({ allowed: false, reason: 'outside-window' });
    expect(
      resolvePublicAccess({ isPublic: true, window: { until: '2026-06-01T00:00:00Z' }, now })
    ).toMatchObject({ allowed: false, reason: 'outside-window' });
    expect(
      resolvePublicAccess({
        isPublic: true,
        window: { from: '2026-06-01T00:00:00Z', until: '2026-07-01T00:00:00Z' },
        now,
      })
    ).toMatchObject({ allowed: true });
  });

  it('does not let a window rescue a video that is not public', () => {
    expect(resolvePublicAccess({ isPublic: false, window: null })).toMatchObject({
      allowed: false,
      reason: 'not-public',
    });
  });
});

describe('toPublicGuidSet', () => {
  it('keeps only well-formed guids, so stored junk cannot become access', () => {
    const set = toPublicGuidSet([GUID, 'nope', '', null, 42]);
    expect(set.has(GUID)).toBe(true);
    expect(set.size).toBe(1);
  });

  it('is safe on missing input', () => {
    expect(toPublicGuidSet(null).size).toBe(0);
    expect(toPublicGuidSet('not an array').size).toBe(0);
  });
});

// The spec's acceptance criterion, exercised against the real page module:
// a video without the public flag must be unreachable on the public route.
// The spec's acceptance criterion: a video without the public flag must be
// unreachable on the public route.
describe('the public watch route', () => {
  const { isVideoPublic, getVideoWindow, getVideo } = spies;

  async function load(id = GUID) {
    const mod = await import('../publicWatch');
    return mod.publicWatchProps({ req: { headers: {} }, res: {}, params: { id } });
  }

  beforeEach(() => {
    isVideoPublic.mockClear().mockImplementation(async () => false);
    getVideoWindow.mockClear().mockImplementation(async () => null);
    getVideo.mockClear();
  });
  it('is notFound for a video that was never marked public', async () => {
    const result = await load();
    expect(result).toEqual({ notFound: true });
    // It must not even ask Bunny about a video it will not serve.
    expect(getVideo).not.toHaveBeenCalled();
  });

  it('serves a video that IS marked public', async () => {
    isVideoPublic.mockImplementation(async () => true);
    const result = await load();
    expect(result.props).toMatchObject({ state: 'ok' });
    expect(result.props.video.guid).toBe(GUID);
    // Playback is still a signed, time-limited token — "public" is about
    // login, not about dropping the signature.
    expect(result.props.embedUrl).toContain('token=');
  });

  it('is notFound for a public video outside its publish window', async () => {
    isVideoPublic.mockImplementation(async () => true);
    getVideoWindow.mockImplementation(async () => ({ from: '2099-01-01T00:00:00Z' }));
    expect(await load()).toEqual({ notFound: true });
  });

  // Same response for every refusal: the route is not an oracle for which
  // guids exist.
  it('is notFound for a malformed id, indistinguishably', async () => {
    expect(await load('not-a-guid')).toEqual({ notFound: true });
    expect(await load('../../secret')).toEqual({ notFound: true });
  });

  it('leaks nothing about the rest of the library in its props', async () => {
    isVideoPublic.mockImplementation(async () => true);
    const { props } = await load();
    const keys = Object.keys(props);
    for (const leaky of ['videos', 'collections', 'total', 'pages', 'user', 'viewers']) {
      expect(keys).not.toContain(leaky);
    }
  });
});
