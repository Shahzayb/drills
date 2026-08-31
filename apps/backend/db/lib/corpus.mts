import type { Faker } from '@faker-js/faker';

export const PHASE = {
  OPENING: 'opening',
  ACK: 'ack',
  DETAIL: 'detail',
  INVESTIGATING: 'investigating',
  FOLLOWUP: 'followup',
  RESOLUTION: 'resolution',
};

const FEATURES = [
  'CSV export',
  'SSO login',
  'webhook delivery',
  'the audit log',
  'billing portal',
  'the mobile app',
  'search',
  'the API',
  'two-factor authentication',
  'email digests',
  'the reporting dashboard',
  'bulk import',
  'team invitations',
  'the Slack integration',
  'saved views',
  'custom fields',
  'the activity feed',
  'attachment upload',
  'scheduled reports',
  'the admin console',
  'seat management',
  'data retention settings',
  'the Zapier integration',
  'inbox filters',
  'canned responses',
  'the public status page',
  'invoice download',
  'usage alerts',
  'the onboarding checklist',
  'role permissions',
];

const BROWSERS = [
  'Chrome',
  'Safari',
  'Firefox',
  'Edge',
  'Chrome on Android',
  'Safari on iOS',
];
const PLATFORMS = [
  'macOS',
  'Windows 11',
  'Ubuntu 24.04',
  'iOS 18',
  'Android 15',
  'Windows 10',
];
const PLANS = ['Free', 'Basic', 'Pro'];

const WHENS = [
  'the 3rd',
  'the 14th',
  'Tuesday',
  'Thursday',
  'the weekend',
  'March 14',
  'the 2nd',
  'Monday',
  'last week',
  'yesterday',
  'the 21st',
  'Friday',
];

const WHEN_ATS = [
  'on the 3rd',
  'on the 14th',
  'last Tuesday',
  'yesterday morning',
  'this morning',
  'last Thursday',
  'over the weekend',
  'on March 14',
  'on the 2nd',
  'late last week',
  'on Monday afternoon',
  'on the 21st',
  'two days ago',
  'earlier today',
  'last month',
];

const sanitise = (s: unknown): string =>
  String(s)
    .replace(/[\\\t\n\r]+/g, ' ')
    .trim();

const times = (n: number, fn: () => string): string[] => {
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = sanitise(fn());
  return out;
};

function buildPools(faker: Faker): Record<string, string[]> {
  return {
    feature: FEATURES,
    browser: BROWSERS,
    platform: PLATFORMS,
    plan: PLANS,
    when: WHENS,
    whenAt: WHEN_ATS,
    name: times(1500, () => faker.person.firstName()),
    fullName: times(1500, () => faker.person.fullName()),
    email: times(1000, () => faker.internet.email()),
    company: times(600, () => faker.company.name()),
    city: times(600, () => faker.location.city()),
    amount: times(
      1000,
      () => `$${faker.finance.amount({ min: 9, max: 4800 })}`,
    ),
    version: times(600, () => faker.system.semver()),
    ref: times(
      4000,
      () =>
        `${faker.string.alpha({ length: 3, casing: 'upper' })}-${faker.number.int({ min: 1000, max: 99999 })}`,
    ),
    errorCode: times(
      500,
      () => `ERR_${faker.number.int({ min: 1000, max: 9999 })}`,
    ),
    count: times(600, () => String(faker.number.int({ min: 3, max: 9800 }))),
    seconds: times(200, () => String(faker.number.int({ min: 4, max: 180 }))),
  };
}

const TEMPLATES = {
  [PHASE.OPENING]: [
    'We were charged twice for the {plan} plan {whenAt} — same amount, two separate line items totalling {amount}.',
    '{feature} has been failing since {when}. Every attempt returns {errorCode} and nothing shows up in the dashboard.',
    '{feature} stops after {count} rows with no warning and no error message. We only noticed when the totals did not match.',
    'Nobody on our team can sign in from {browser} on {platform}. It loops straight back to the login screen.',
    'Since the {version} update, {feature} takes over {seconds} seconds to load for everyone in our {city} office.',
    'Can you confirm whether {feature} is included on the {plan} plan? The pricing page and the in-app banner disagree.',
    'We are seeing duplicate notifications from {feature} — {name} received the same alert {count} times {whenAt}.',
    'Invoices are going to {email}, which is a shared inbox nobody monitors. How do we change the billing contact?',
    '{feature} returns {errorCode} for one specific account and works fine for the rest. Started {whenAt}.',
    'Our {plan} renewal charged {amount} instead of the quoted price. Could someone check what happened?',
    'Is there a way to bulk-remove seats? We are down to {count} active users and still paying for the rest.',
    '{feature} silently drops records over {count} characters. No error, no warning — they just never arrive.',
    'After migrating to {platform} the desktop notifications stopped entirely. {browser} shows no permission prompt at all.',
    'We need {feature} to respect our data retention policy. Right now everything is kept indefinitely.',
    'Feature request: let us pin saved views per team. {fullName} rebuilds the same filter every morning.',
    'The {feature} timestamps are off by an hour for our {city} team — looks like a daylight-saving issue.',
    'Two of our admins lost access to {feature} {whenAt} with no change on our side. Error shown is {errorCode}.',
    'The export we ran {whenAt} finished but the file is empty. It reported {count} rows processed.',
  ],
  [PHASE.ACK]: [
    'Thanks for flagging this — I have reproduced it here and raised it as {ref}. I will come back to you within one business day.',
    'Sorry about that. I can see the failed attempts on your account. Is this affecting every user or only {name}?',
    'Got it, and apologies for the disruption. Tracking this as {ref}. Could you confirm which {browser} version you are on?',
    'Thanks for the detail — that is enough to reproduce. I have escalated it to the team that owns {feature} as {ref}.',
    'Appreciate the report. I can confirm the duplicate charge of {amount} and have flagged it to billing under {ref}.',
    'That is not expected behaviour. Logged as {ref}. Would you be able to share the exact time you saw {errorCode}?',
    'Understood — I have opened {ref} and set it to high priority given it is blocking your whole team.',
    'Thanks for your patience. I can see {count} failed requests on the account since {when}. Investigating now as {ref}.',
    'Confirmed on our side too. This is a known issue with {feature} on {platform}, tracked as {ref}.',
    'Good catch. That is a documentation error rather than a billing one — {feature} is not part of the {plan} plan.',
    'I have your account open now. Before I dig in, can you confirm whether {fullName} still needs admin access?',
    'Thanks — I can see this in the logs. Raising {ref} with engineering and will keep you posted.',
  ],
  [PHASE.DETAIL]: [
    'It affects everyone on the account, not just {name}. Happy to jump on a call if that is easier.',
    'Attaching the console output — it fails with {errorCode} every time, on both {browser} and {platform}.',
    'It started right after we added {count} new seats {whenAt}. Nothing else changed on our side.',
    'Only {fullName} is affected. Everyone else on {browser} is fine, which is what makes it odd.',
    'Reproduced it three times just now. Same {errorCode}, same point in the flow, roughly {seconds} seconds in.',
    'Yes, still happening. I tried from a clean profile on {platform} and got the identical result.',
    'To be clear, the charge of {amount} is the second one — the first went through correctly {whenAt}.',
    'We are on the {plan} plan, billed annually. Account email is {email} if that helps you find it.',
    'It works on {browser} but not on our managed devices, so it may be a policy on {platform} rather than your side.',
    'Roughly {count} records are affected. I can send the list if you tell me where to upload it.',
    'Our {city} office sees it consistently; the rest of the team does not see it at all.',
  ],
  [PHASE.INVESTIGATING]: [
    'Update on {ref}: engineering has narrowed it to whatever drives {feature}. A fix is expected in {version}.',
    'Quick update — we found the cause. {feature} was retrying failed jobs without a backoff, which is where {errorCode} comes from.',
    'Still working on {ref}. The fix touches billing, so it is going through an extra review before release.',
    'We have reproduced this in staging. It only triggers above {count} rows, which is why it looked intermittent.',
    'Progress on {ref}: a workaround is available now, and the permanent fix ships with {version} next week.',
    'The team confirmed this is a regression introduced in {version}. Rolling back is being tested today.',
    'Not forgotten — {ref} is with the team that owns {feature}. I will have a firmer date for you by {when}.',
    'We traced the duplicate charges to a retry in the payment webhook. {count} accounts were affected, including yours.',
  ],
  [PHASE.FOLLOWUP]: [
    'Any movement on {ref}? This is still blocking our {city} team.',
    'Checking in — we are still seeing {errorCode} as of {when}. Has the fix shipped yet?',
    'Following up on the {amount} refund. It has not appeared on our statement.',
    'Is there an ETA on {ref}? We have a board review coming up and {feature} is part of it.',
    'Still no change here. {fullName} tried again this morning on {browser} with the same result.',
    'Sorry to chase — has {version} gone out? We are still on the previous release.',
    'Any update? We have had to move {count} people onto a manual process in the meantime.',
  ],
  [PHASE.RESOLUTION]: [
    'This is now fixed in {version} and deployed to everyone. {feature} should behave normally — tell me if {errorCode} comes back.',
    'The refund of {amount} has been issued to the original payment method. It should land within five working days.',
    'Fixed and released. Thanks for your patience on {ref} — the detail you sent is what let us reproduce it.',
    'Confirmed resolved on our side. I have credited {amount} to the account for the disruption.',
    '{version} is live and {feature} is back to normal for all {count} of your users. Closing {ref}.',
    'Sorted — the billing contact is now {email} and future invoices will go there.',
    'Deployed the fix this morning. {fullName} should be able to sign in from {browser} again.',
    'Closing this one out. {feature} now respects your retention settings, effective immediately.',
    'All done. If anything looks off after {when}, reply here and it will reopen the same thread.',
    'The seats have been removed and your next invoice drops to {amount}. Sorry it took a few rounds.',
  ],
};

const SLOT_RE = /\{(\w+)\}/g;

export type Rng = () => number;

export interface Corpus {
  body: (phase: string) => string;
  pools: Record<string, string[]>;
}

/**
 * @param faker  a seeded faker instance
 * @param rng    () => [0,1), seeded
 */
export function createCorpus(faker: Faker, rng: Rng): Corpus {
  const pools = buildPools(faker);

  for (const list of Object.values(TEMPLATES)) {
    for (const t of list) {
      if (/[\\\t\n\r]/.test(t))
        throw new Error(`Template contains a COPY metacharacter: ${t}`);
      for (const [, slot] of t.matchAll(SLOT_RE)) {
        if (!pools[slot])
          throw new Error(`Template uses unknown slot {${slot}}: ${t}`);
      }
    }
  }

  const pick = (arr: string[]) => arr[(rng() * arr.length) | 0];

  const render = (template: string) =>
    template.replace(SLOT_RE, (_, slot) => pick(pools[slot]));

  const capitalise = (s: string) =>
    s.replace(
      /(^|[.!?] )([a-z])/g,
      (_, lead: string, c: string) => lead + c.toUpperCase(),
    );

  function body(phase: string): string {
    const list = TEMPLATES[phase];
    const u = rng();
    const sentences = u < 0.4 ? 1 : u < 0.85 ? 2 : 3;

    const used: number[] = [(rng() * list.length) | 0];
    for (let i = 1; i < sentences; i++) {
      let index: number;
      do {
        index = (rng() * list.length) | 0;
      } while (used.includes(index));
      used.push(index);
    }

    return capitalise(used.map((index) => render(list[index])).join(' '));
  }

  return { body, pools };
}

export function phaseFor(
  index: number,
  total: number,
  closed: boolean,
): string {
  if (index === 0) return PHASE.OPENING;
  if (index === 1) return PHASE.ACK;
  if (index === total - 1) return closed ? PHASE.RESOLUTION : PHASE.FOLLOWUP;
  const cycle = (index - 2) % 3;
  return cycle === 0
    ? PHASE.DETAIL
    : cycle === 1
      ? PHASE.INVESTIGATING
      : PHASE.FOLLOWUP;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
