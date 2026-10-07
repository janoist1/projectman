import { describe, it, expect } from 'vitest';
import { workMap, isStale, staleDays, STALE_AFTER_MS, MAP_OTHER_GROUP_KEY, mapStateOf } from './work-map';
import type { MapTask, MapState, TaskPhase } from './work-map';
import type { StageKind } from './pipeline';

describe('isStale', () => {
  const ONE_DAY = 24 * 60 * 60 * 1000;

  it('ismeretlen szakasz nem régóta álló', () => {
    const task: MapTask = { key: 'PM-1', kind: 'task', status: 'active', stageId: 's1', createdAt: new Date().toISOString() };
    expect(isStale(task, 'waiting', undefined, Date.now() + STALE_AFTER_MS)).toBe(false);
  });

  it('queue szakasz soha nem régóta álló', () => {
    const task: MapTask = { key: 'PM-1', kind: 'task', status: 'active', stageId: 's1', createdAt: new Date().toISOString() };
    expect(isStale(task, 'waiting', 'queue', Date.now() + STALE_AFTER_MS)).toBe(false);
  });

  it('waiting vagy ready fázis régóta álló lehet', () => {
    const t0 = Date.now();
    const task: MapTask = { key: 'PM-1', kind: 'task', status: 'active', stageId: 's1', createdAt: new Date(t0).toISOString() };
    
    // Határok (24h - 1ms vs 24h)
    expect(isStale(task, 'waiting', 'work', t0 + STALE_AFTER_MS - 1)).toBe(false);
    expect(isStale(task, 'waiting', 'work', t0 + STALE_AFTER_MS)).toBe(true);

    expect(isStale(task, 'ready', 'step', t0 + STALE_AFTER_MS - 1)).toBe(false);
    expect(isStale(task, 'ready', 'step', t0 + STALE_AFTER_MS)).toBe(true);
  });

  it('más fázis nem régóta álló', () => {
    const t0 = Date.now();
    const task: MapTask = { key: 'PM-1', kind: 'task', status: 'active', stageId: 's1', createdAt: new Date(t0).toISOString() };
    expect(isStale(task, 'working', 'work', t0 + STALE_AFTER_MS)).toBe(false);
    expect(isStale(task, 'blocked', 'work', t0 + STALE_AFTER_MS)).toBe(false);
  });
});

describe('workMap', () => {
  it('csoportosítja a témákat és a gyűjtőkártyákat', () => {
    const tasks: MapTask[] = [
      { key: 'T-1', kind: 'theme', status: 'active', stageId: 's1', createdAt: '' }, // Téma
      { key: 'P-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-1' }, // Téma gyereke
      { key: 'C-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '' }, // Gyűjtőkártya (téma nélkül)
      { key: 'P-2', kind: 'task', status: 'active', stageId: 's1', createdAt: '', parentKey: 'C-1' }, // C-1 gyereke
      { key: 'O-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '' }, // Other kártya
    ];
    
    const states = new Map<string, MapState | null>();
    const groups = workMap({ tasks, states });

    expect(groups.length).toBe(3); // Téma, Collector, Other
    
    const themeGroup = groups.find(g => g.key === 'T-1');
    expect(themeGroup).toBeDefined();
    expect(themeGroup?.kind).toBe('theme');
    expect(themeGroup?.cardKeys).toContain('P-1');

    const collectorGroup = groups.find(g => g.key === 'C-1');
    expect(collectorGroup).toBeDefined();
    expect(collectorGroup?.kind).toBe('collector');
    expect(collectorGroup?.cardKeys).toContain('C-1');
    expect(collectorGroup?.cardKeys).toContain('P-2');

    const otherGroup = groups.find(g => g.key === MAP_OTHER_GROUP_KEY);
    expect(otherGroup).toBeDefined();
    expect(otherGroup?.kind).toBe('other');
    expect(otherGroup?.cardKeys).toContain('O-1');
  });

  it('lezárt téma/gyűjtőkártya gyerekei hova kerülnek', () => {
    const tasks: MapTask[] = [
      { key: 'T-1', kind: 'theme', status: 'done', stageId: 's1', createdAt: '' }, // Lezárt téma
      { key: 'P-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-1' }, // Lezárt téma gyereke -> other
      { key: 'C-1', kind: 'task', status: 'done', stageId: 's1', createdAt: '' }, // Lezárt gyűjtő
      { key: 'P-2', kind: 'task', status: 'active', stageId: 's1', createdAt: '', parentKey: 'C-1' }, // Lezárt gyűjtő gyereke -> other
    ];

    const states = new Map<string, MapState | null>();
    const groups = workMap({ tasks, states });

    // "Minden nyitott témának van csoportja" -> T-1 lezárt, szóval nincs csoportja, csak other van.
    // "különben a gyökér (a szülő, ha a tasks-ban van...) nyitott gyűjtőkártya" -> C-1 lezárt, tehát other.
    expect(groups.length).toBe(1);
    expect(groups[0].key).toBe(MAP_OTHER_GROUP_KEY);
    expect(groups[0].cardKeys).toContain('P-1');
    expect(groups[0].cardKeys).toContain('P-2');
  });

  it('ügyfél elől rejtett szülő: gyökér a szülő ha a tasks-ban van, különben maga a kártya', () => {
    // Tegyük fel, hogy a szülő nincs benne a tasks-ban, de a kártyának van parentKey-e
    const tasks: MapTask[] = [
      { key: 'C-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '', parentKey: 'HIDDEN' }, // HIDDEN nincs a tasks-ban
      { key: 'P-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '', parentKey: 'C-1' },
    ];
    
    // C-1 maga is gyűjtőkártya lesz, mert P-1 a gyereke!
    const states = new Map<string, MapState | null>();
    const groups = workMap({ tasks, states });
    
    expect(groups.length).toBe(1);
    expect(groups[0].key).toBe('C-1'); // C-1 lett a collector group
    expect(groups[0].kind).toBe('collector');
    expect(groups[0].cardKeys).toContain('C-1');
    expect(groups[0].cardKeys).toContain('P-1');
  });

  it('counts paraméter kiszűri a csoportokat és a jeleket', () => {
    const tasks: MapTask[] = [
      { key: 'T-1', kind: 'theme', status: 'active', stageId: 's1', createdAt: '' },
      { key: 'P-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-1' },
      { key: 'P-2', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-1' },
    ];
    const states = new Map<string, MapState | null>([
      ['P-1', 'working'],
      ['P-2', 'waiting'],
    ]);

    // Csak a P-1 számít
    const groups = workMap({ tasks, states, counts: (key) => key === 'P-1' });

    expect(groups.length).toBe(1);
    expect(groups[0].key).toBe('T-1');
    expect(groups[0].signals.working).toBe(1);
    expect(groups[0].signals.waiting).toBe(0);
    expect(groups[0].signals.open).toBe(1); // Csak a P-1
    // De progressben minden kártya benne van!
    expect(groups[0].progress.total).toBe(2);
  });

  it('ha counts egyetlen kártyát sem fogad el a csoportból, a csoport kimarad', () => {
    const tasks: MapTask[] = [
      { key: 'T-1', kind: 'theme', status: 'active', stageId: 's1', createdAt: '' },
      { key: 'P-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-1' },
    ];
    const states = new Map<string, MapState | null>();
    
    const groups = workMap({ tasks, states, counts: () => false }); // Senkit sem fogad el
    expect(groups.length).toBe(0);
  });
});
