export interface ContributorLink {
  label: string;
  href: string;
}

export interface Contributor {
  /** Stable, URL-safe identity. Never derive links from a display name. */
  id: string;
  displayName: string;
  /** Historical spellings, romanizations and bylines accepted in old front matter. */
  aliases: readonly string[];
  /** Team membership is opt-in; publishing a contribution does not imply membership. */
  teamMember: boolean;
  entityType?: "person" | "organization";
  teamTitle?: string;
  teamOrder?: number;
  bio?: string;
  links?: readonly ContributorLink[];
}

/**
 * Public contributor identities used by published content.
 *
 * Keep `id` stable when a display name changes. Every authoring, translation,
 * editing or proofreading byline must resolve to one of these records before a
 * post can be built. Team data deliberately defaults to false until a person
 * has explicitly agreed to be listed on the About page.
 */
export const CONTRIBUTORS = [
  {
    id: "hatsushimo",
    displayName: "Hatsushimo",
    aliases: [],
    teamMember: false,
  },
  {
    id: "ho-jyuwai",
    displayName: "Ho Jyuwai",
    aliases: [],
    teamMember: false,
  },
  {
    id: "jack-cade",
    displayName: "Jack Cade",
    aliases: [],
    teamMember: false,
  },
  {
    id: "wang-kui",
    displayName: "王揆",
    aliases: [],
    teamMember: false,
  },
  {
    id: "danshui",
    displayName: "淡水",
    aliases: ["danshui"],
    teamMember: false,
  },
  {
    id: "grigory-zinoviev",
    displayName: "格里戈里·季诺维也夫",
    aliases: ["Grigory Zinoviev", "Grigori Zinoviev"],
    teamMember: false,
  },
  {
    id: "wang-yu",
    displayName: "王鱼",
    aliases: [],
    teamMember: false,
  },
  {
    id: "vladimir-pechatnov",
    displayName: "弗拉基米尔·奥·佩恰特诺夫",
    aliases: ["Vladimir O. Pechatnov", "Vladimir Pechatnov"],
    teamMember: false,
  },
  {
    id: "zhui-qu",
    displayName: "追曲",
    aliases: [],
    teamMember: false,
  },
  {
    id: "yuri-olsevich",
    displayName: "尤利·奥尔塞维奇",
    aliases: ["Yuri Olsevich", "Yuli Olsevich"],
    teamMember: false,
  },
  {
    id: "paul-gregory",
    displayName: "保罗·格雷戈里",
    aliases: ["Paul Gregory", "Paul R. Gregory"],
    teamMember: false,
  },
  {
    id: "lars-t-lih",
    displayName: "拉斯·T·李赫",
    aliases: ["Lars T. Lih", "Lars Lih"],
    teamMember: false,
  },
  {
    id: "vasily-shulgin",
    displayName: "瓦西里·维塔利耶维奇·舒尔金",
    aliases: ["Василий Витальевич Шульгин", "В. В. Шульгин", "Vasily Vitalyevich Shulgin", "Vasily Shulgin"],
    teamMember: false,
  },
  {
    id: "yu-shulue",
    displayName: "俞叔略",
    aliases: [],
    teamMember: false,
  },
  {
    id: "fang-cao",
    displayName: "芳草",
    aliases: [],
    teamMember: false,
  },
  {
    id: "franco-piperno",
    displayName: "弗朗科·皮佩尔诺",
    aliases: ["Franco Piperno"],
    teamMember: false,
  },
  {
    id: "potere-operaio",
    displayName: "“工人力量”社",
    aliases: ["Potere operaio", "Potere operario", "工人力量", "工人力量社"],
    teamMember: false,
    entityType: "organization",
  },
  {
    id: "nan-xinfeng",
    displayName: "南新风",
    aliases: [],
    teamMember: false,
  },
  {
    id: "charlotte-robertson",
    displayName: "夏洛特·罗伯逊",
    aliases: ["Charlotte Robertson"],
    teamMember: false,
  },
  {
    id: "wolf-ladejinsky",
    displayName: "雷正琪",
    aliases: ["沃尔夫·拉迪金斯基", "Wolf Ladejinsky", "Wolf Isaac Ladejinsky"],
    teamMember: false,
  },
  {
    id: "francois-crouzet",
    displayName: "顾鲁泽",
    aliases: ["François Crouzet", "Francois Crouzet", "弗朗索瓦·顾鲁泽"],
    teamMember: false,
  },
  {
    id: "takafusa-nakamura",
    displayName: "中村隆英",
    aliases: ["Nakamura Takafusa", "Takafusa Nakamura"],
    teamMember: false,
  },
  {
    id: "yukio-yanbe",
    displayName: "山家悠纪夫",
    aliases: ["Yanbe Yukio", "Yukio Yanbe", "山家悠紀夫"],
    teamMember: false,
  },
  {
    id: "shunsuke-takagi",
    displayName: "高木俊辅",
    aliases: ["Takagi Shunsuke", "Shunsuke Takagi", "高木俊輔"],
    teamMember: false,
  },
  {
    id: "western-un-canon-translation-group",
    displayName: "西方负典编译组",
    aliases: [],
    teamMember: false,
    entityType: "organization",
  },
] as const satisfies readonly Contributor[];

export type ContributorId = (typeof CONTRIBUTORS)[number]["id"];

const ASCII_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const contributorById = new Map<ContributorId, (typeof CONTRIBUTORS)[number]>();
const contributorByName = new Map<string, (typeof CONTRIBUTORS)[number]>();

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

for (const contributor of CONTRIBUTORS) {
  if (!ASCII_ID_RE.test(contributor.id)) {
    throw new Error(`Contributor id must be lowercase ASCII kebab-case: ${contributor.id}`);
  }
  if (contributorById.has(contributor.id)) {
    throw new Error(`Duplicate contributor id: ${contributor.id}`);
  }
  contributorById.set(contributor.id, contributor);

  for (const name of [contributor.displayName, ...contributor.aliases]) {
    const normalized = normalizeName(name);
    const existing = contributorByName.get(normalized);
    if (existing && existing.id !== contributor.id) {
      throw new Error(`Contributor name or alias is ambiguous: ${name}`);
    }
    contributorByName.set(normalized, contributor);
  }
}

export function isContributorId(value: string): value is ContributorId {
  return contributorById.has(value as ContributorId);
}

export function getContributor(id: ContributorId): (typeof CONTRIBUTORS)[number] {
  const contributor = contributorById.get(id);
  if (!contributor) throw new Error(`Unknown contributor id: ${id}`);
  return contributor;
}

export function findContributor(id: string): (typeof CONTRIBUTORS)[number] | null {
  return contributorById.get(id as ContributorId) ?? null;
}

export function findContributorByName(name: string): (typeof CONTRIBUTORS)[number] | null {
  return contributorByName.get(normalizeName(name)) ?? null;
}

export function contributorEntityType(id: string): "person" | "organization" {
  const contributor = contributorById.get(id as ContributorId) as Contributor | undefined;
  return contributor?.entityType ?? "person";
}

export function getTeamMembers(): Contributor[] {
  return (CONTRIBUTORS as readonly Contributor[]).filter((contributor) => contributor.teamMember).sort(
    (a, b) => (a.teamOrder ?? Number.MAX_SAFE_INTEGER) - (b.teamOrder ?? Number.MAX_SAFE_INTEGER)
  );
}
