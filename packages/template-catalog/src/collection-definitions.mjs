/**
 * Personal templates. Each is one collection: a schema, several views over the same sample rows,
 * and the first view is the one the library card draws.
 *
 * `rows` are `[title, properties, prompt]`. A `{ day: n }` value is a date n days after the date
 * the person gives when they apply the template.
 */

const day = (offset) => ({ day: offset });

// shortcut: a habit's start date and time zone cannot be bound to an input (rules reach schema
// properties only), so sample habits start on the build's fixed day in UTC; upgrade when Core
// re-anchors habit settings on template application.
const habit = (target, unit) => ({
  $habit_frequency: 'daily',
  $habit_weekdays: [],
  $habit_timezone: 'UTC',
  $habit_start_date: '2026-10-05',
  $habit_target: target,
  $habit_unit: unit,
});

export const COLLECTIONS = [
  {
    key: 'nix.habit-tracker',
    name: 'Habit tracker',
    description:
      'A handful of small daily habits with a weekly check-in grid. Rename them, change the targets, and tick each day off.',
    inputs: [['name', 'Tracker name', 'text', 'Habits']],
    properties: [['area', 'Area', 'select', ['Health', 'Mind', 'Home']]],
    views: [
      { kind: 'habit_tracker', name: 'Habits' },
      { kind: 'chart', name: 'By area', groupBy: 'area' },
      { kind: 'list', name: 'All habits', columns: ['area'] },
    ],
    rows: [
      ['Drink water', { area: 'Health', ...habit(8, 'glasses') }, 'Keep a glass where you work.'],
      ['Move', { area: 'Health', ...habit(30, 'minutes') }, 'A walk counts. So does the stairs.'],
      ['Read', { area: 'Mind', ...habit(20, 'pages') }, 'Leave the book where you will see it.'],
      ['Write in the journal', { area: 'Mind', ...habit(3, 'lines') }, 'Three lines is enough.'],
      ['Tidy one surface', { area: 'Home', ...habit(1, 'time') }, 'One desk, one shelf, one sink.'],
      ['Lights out by eleven', { area: 'Health', ...habit(1, 'time') }, 'Phone outside the room.'],
    ],
  },
  {
    key: 'nix.priority-matrix',
    name: 'Priority matrix',
    description:
      'Sort what is on your plate by urgency and importance, then do the top-left corner first.',
    inputs: [
      ['name', 'Matrix name', 'text', 'Priorities'],
      ['start', 'Start date', 'date'],
    ],
    properties: [
      ['urgency', 'Urgency', 'select', ['Urgent', 'Not urgent']],
      ['importance', 'Importance', 'select', ['Important', 'Not important']],
      ['due', 'Due', 'date'],
      ['done', 'Done', 'checkbox'],
    ],
    views: [
      {
        kind: 'matrix',
        name: 'Matrix',
        groupBy: 'urgency',
        groupOrder: ['Urgent', 'Not urgent'],
        rowBy: 'importance',
      },
      {
        kind: 'query',
        name: 'Do first',
        columns: ['due'],
        filters: [
          { property: 'urgency', operator: 'equals', value: 'Urgent' },
          { property: 'importance', operator: 'equals', value: 'Important' },
        ],
      },
      { kind: 'checklist', name: 'Checklist', doneProperty: 'done', columns: ['due'] },
    ],
    rows: [
      [
        'Submit the tax return',
        { urgency: 'Urgent', importance: 'Important', due: day(1), done: false },
        'Urgent and important: do it first.',
      ],
      [
        'Fix the leaking tap',
        { urgency: 'Urgent', importance: 'Important', due: day(2), done: false },
        'Urgent and important: do it first.',
      ],
      [
        'Plan next quarter',
        { urgency: 'Not urgent', importance: 'Important', due: day(10), done: false },
        'Important, not urgent: give it a date.',
      ],
      [
        'Book a health check',
        { urgency: 'Not urgent', importance: 'Important', due: day(14), done: false },
        'Important, not urgent: give it a date.',
      ],
      [
        'Reply to the group chat',
        { urgency: 'Urgent', importance: 'Not important', due: day(0), done: true },
        'Urgent, not important: keep it short or hand it on.',
      ],
      [
        'Return the parcel',
        { urgency: 'Urgent', importance: 'Not important', due: day(3), done: false },
        'Urgent, not important: keep it short or hand it on.',
      ],
      [
        'Reorganise the bookmarks',
        { urgency: 'Not urgent', importance: 'Not important', done: false },
        'Neither: let it go.',
      ],
      [
        'Compare phone plans',
        { urgency: 'Not urgent', importance: 'Not important', done: false },
        'Neither: let it go.',
      ],
    ],
  },
  {
    key: 'nix.goals',
    name: 'Goals',
    description:
      'A few goals for the season, each with a start, a target date and a progress figure you update as you go.',
    inputs: [
      ['name', 'Goal list name', 'text', 'Goals'],
      ['start', 'Start date', 'date'],
    ],
    properties: [
      ['area', 'Area', 'select', ['Health', 'Career', 'Money', 'Learning']],
      ['status', 'Status', 'select', ['Not started', 'On track', 'At risk', 'Done']],
      ['starts', 'Starts', 'date'],
      ['target', 'Target date', 'date'],
      ['progress', 'Progress (%)', 'number'],
    ],
    views: [
      {
        kind: 'timeline',
        name: 'Roadmap',
        dateProperty: 'starts',
        endDateProperty: 'target',
        mode: 'month',
        columns: ['status'],
      },
      {
        kind: 'board',
        name: 'By status',
        groupBy: 'status',
        groupOrder: ['Not started', 'On track', 'At risk', 'Done'],
        columns: ['area', 'target'],
      },
      {
        kind: 'chart',
        name: 'Progress by area',
        groupBy: 'area',
        measure: 'sum',
        measureProperty: 'progress',
      },
      { kind: 'list', name: 'All goals', columns: ['area', 'status', 'target', 'progress'] },
    ],
    rows: [
      [
        'Run 10 km without stopping',
        { area: 'Health', status: 'On track', starts: day(0), target: day(56), progress: 40 },
        'Write what done looks like, and the next small step.',
      ],
      [
        'Save an emergency fund',
        { area: 'Money', status: 'On track', starts: day(0), target: day(84), progress: 55 },
        'Write what done looks like, and the next small step.',
      ],
      [
        'Finish the certification',
        { area: 'Career', status: 'At risk', starts: day(7), target: day(49), progress: 20 },
        'Write what done looks like, and the next small step.',
      ],
      [
        'Hold a conversation in Spanish',
        { area: 'Learning', status: 'On track', starts: day(14), target: day(77), progress: 30 },
        'Write what done looks like, and the next small step.',
      ],
      [
        'Ship the side project',
        { area: 'Career', status: 'Not started', starts: day(28), target: day(70), progress: 0 },
        'Write what done looks like, and the next small step.',
      ],
      [
        'Sleep seven hours a night',
        { area: 'Health', status: 'Done', starts: day(0), target: day(21), progress: 100 },
        'Write what done looks like, and the next small step.',
      ],
    ],
  },
  {
    key: 'nix.trip-plan',
    name: 'Trip plan',
    description:
      'An itinerary on a timeline, with the things still to book as a checklist and the cost added up.',
    inputs: [
      ['name', 'Trip name', 'text', 'Trip'],
      ['start', 'Departure date', 'date'],
    ],
    properties: [
      ['kind', 'Kind', 'select', ['Travel', 'Stay', 'Activity', 'Prepare']],
      ['starts', 'Starts', 'date'],
      ['ends', 'Ends', 'date'],
      ['booked', 'Booked', 'checkbox'],
      ['cost', 'Cost', 'number'],
    ],
    views: [
      {
        kind: 'timeline',
        name: 'Itinerary',
        dateProperty: 'starts',
        endDateProperty: 'ends',
        mode: 'month',
        columns: ['kind'],
      },
      { kind: 'calendar', name: 'Calendar', dateProperty: 'starts', sortBy: 'starts' },
      { kind: 'checklist', name: 'To book', doneProperty: 'booked', columns: ['kind'] },
      {
        kind: 'chart',
        name: 'Cost by kind',
        groupBy: 'kind',
        measure: 'sum',
        measureProperty: 'cost',
      },
    ],
    rows: [
      [
        'Renew travel insurance',
        { kind: 'Prepare', starts: day(-7), booked: true, cost: 40 },
        'Policy number and the emergency line.',
      ],
      [
        'Flight out',
        { kind: 'Travel', starts: day(0), ends: day(0), booked: true, cost: 320 },
        'Booking reference, terminal and baggage allowance.',
      ],
      [
        'Hotel in the old town',
        { kind: 'Stay', starts: day(0), ends: day(4), booked: true, cost: 480 },
        'Address, check-in time and confirmation.',
      ],
      [
        'Walking tour',
        { kind: 'Activity', starts: day(1), ends: day(1), booked: false, cost: 25 },
        'Meeting point and what to bring.',
      ],
      [
        'Day hike',
        { kind: 'Activity', starts: day(2), ends: day(2), booked: false, cost: 0 },
        'Route, start time and the weather the night before.',
      ],
      [
        'Coast by train',
        { kind: 'Travel', starts: day(4), ends: day(4), booked: false, cost: 60 },
        'Departure station and seat reservation.',
      ],
      [
        'Guesthouse by the sea',
        { kind: 'Stay', starts: day(4), ends: day(7), booked: false, cost: 270 },
        'Address, check-in time and confirmation.',
      ],
      [
        'Flight home',
        { kind: 'Travel', starts: day(7), ends: day(7), booked: true, cost: 300 },
        'Booking reference, terminal and baggage allowance.',
      ],
    ],
  },
  {
    key: 'nix.reading-list',
    name: 'Reading list',
    description:
      'Books and articles as a shelf of cards: what you want to read, what you are reading and what you thought.',
    inputs: [['name', 'List name', 'text', 'Reading list']],
    properties: [
      ['author', 'Author', 'text'],
      ['kind', 'Kind', 'select', ['Book', 'Article', 'Paper']],
      ['status', 'Status', 'select', ['To read', 'Reading', 'Finished']],
      ['rating', 'Rating (1-5)', 'number'],
    ],
    views: [
      { kind: 'gallery', name: 'Shelf', columns: ['author'], cardSize: 'medium' },
      {
        kind: 'board',
        name: 'By status',
        groupBy: 'status',
        groupOrder: ['To read', 'Reading', 'Finished'],
        columns: ['author'],
      },
      { kind: 'chart', name: 'By kind', groupBy: 'kind' },
      { kind: 'form', name: 'Add to the list', columns: ['author', 'kind', 'status'] },
    ],
    rows: [
      [
        'Deep Work',
        { author: 'Cal Newport', kind: 'Book', status: 'Finished', rating: 4 },
        'What stayed with you? One paragraph.',
      ],
      [
        'Four Thousand Weeks',
        { author: 'Oliver Burkeman', kind: 'Book', status: 'Finished', rating: 5 },
        'What stayed with you? One paragraph.',
      ],
      [
        'How to Take Smart Notes',
        { author: 'Sönke Ahrens', kind: 'Book', status: 'Reading' },
        'Notes as you go.',
      ],
      [
        'Thinking, Fast and Slow',
        { author: 'Daniel Kahneman', kind: 'Book', status: 'Reading' },
        'Notes as you go.',
      ],
      [
        'The Pragmatic Programmer',
        { author: 'David Thomas and Andrew Hunt', kind: 'Book', status: 'To read' },
        'Why this is on the list.',
      ],
      [
        'As We May Think',
        { author: 'Vannevar Bush', kind: 'Article', status: 'To read' },
        'Why this is on the list.',
      ],
    ],
  },
  {
    key: 'nix.personal-crm',
    name: 'People',
    description:
      'The people you want to stay close to, when you last spoke and when to get in touch next.',
    inputs: [
      ['name', 'List name', 'text', 'People'],
      ['start', 'Start date', 'date'],
    ],
    properties: [
      ['circle', 'Circle', 'select', ['Family', 'Friend', 'Colleague', 'Mentor']],
      ['place', 'Where', 'text'],
      ['last_contact', 'Last contact', 'date'],
      ['follow_up', 'Next follow-up', 'date'],
    ],
    views: [
      { kind: 'sheet', name: 'People', columns: ['circle', 'place', 'last_contact', 'follow_up'] },
      { kind: 'calendar', name: 'Follow-ups', dateProperty: 'follow_up', sortBy: 'follow_up' },
      {
        kind: 'query',
        name: 'Get in touch this week',
        columns: ['circle', 'follow_up'],
        filters: [{ property: 'follow_up', operator: 'within-next', value: '7' }],
      },
      {
        kind: 'board',
        name: 'By circle',
        groupBy: 'circle',
        groupOrder: ['Family', 'Friend', 'Colleague', 'Mentor'],
        columns: ['follow_up'],
      },
    ],
    rows: [
      [
        'Amara',
        { circle: 'Family', place: 'Lagos', last_contact: day(-6), follow_up: day(1) },
        'What you talked about, and what to ask next time.',
      ],
      [
        'Uncle Chidi',
        { circle: 'Family', place: 'Enugu', last_contact: day(-30), follow_up: day(3) },
        'What you talked about, and what to ask next time.',
      ],
      [
        'Tomás',
        { circle: 'Friend', place: 'Lisbon', last_contact: day(-45), follow_up: day(5) },
        'What you talked about, and what to ask next time.',
      ],
      [
        'Priya',
        { circle: 'Friend', place: 'London', last_contact: day(-12), follow_up: day(16) },
        'What you talked about, and what to ask next time.',
      ],
      [
        'Dana',
        { circle: 'Colleague', place: 'Remote', last_contact: day(-3), follow_up: day(11) },
        'What you talked about, and what to ask next time.',
      ],
      [
        'Professor Mensah',
        { circle: 'Mentor', place: 'Accra', last_contact: day(-60), follow_up: day(8) },
        'What you talked about, and what to ask next time.',
      ],
    ],
  },
  {
    key: 'nix.daily-journal',
    name: 'Daily journal',
    description:
      'One entry a day, with a mood and a single highlight, so a month can be read at a glance.',
    inputs: [
      ['name', 'Journal name', 'text', 'Journal'],
      ['start', 'First day', 'date'],
    ],
    properties: [
      ['date', 'Date', 'date'],
      ['mood', 'Mood', 'select', ['Great', 'Good', 'Okay', 'Low']],
      ['highlight', 'Highlight', 'text'],
    ],
    views: [
      { kind: 'calendar', name: 'Calendar', dateProperty: 'date', sortBy: 'date' },
      { kind: 'outline', name: 'Outline' },
      {
        kind: 'chart',
        name: 'Mood',
        groupBy: 'mood',
        groupOrder: ['Great', 'Good', 'Okay', 'Low'],
      },
      { kind: 'list', name: 'Entries', columns: ['date', 'mood', 'highlight'], sortBy: 'date' },
    ],
    rows: [
      [
        'A slow start, a good finish',
        { date: day(0), mood: 'Good', highlight: 'Finished the draft' },
        'What happened, what you noticed, what you want to remember.',
      ],
      [
        'Long walk after work',
        { date: day(1), mood: 'Great', highlight: 'An hour outside' },
        'What happened, what you noticed, what you want to remember.',
      ],
      [
        'Too many meetings',
        { date: day(2), mood: 'Okay', highlight: 'Lunch with a friend' },
        'What happened, what you noticed, what you want to remember.',
      ],
      [
        'Tired and behind',
        { date: day(3), mood: 'Low', highlight: 'Early night' },
        'What happened, what you noticed, what you want to remember.',
      ],
      [
        'Caught up',
        { date: day(4), mood: 'Good', highlight: 'Cleared the inbox' },
        'What happened, what you noticed, what you want to remember.',
      ],
      [
        'Market and cooking',
        { date: day(5), mood: 'Great', highlight: 'Tried a new recipe' },
        'What happened, what you noticed, what you want to remember.',
      ],
      [
        'A quiet Sunday',
        { date: day(6), mood: 'Good', highlight: 'Planned the week' },
        'What happened, what you noticed, what you want to remember.',
      ],
    ],
  },
  {
    key: 'nix.document-vault',
    name: 'Document vault',
    description:
      'The papers you need once a year and can never find. Attach the scan to each page and note when it runs out.',
    inputs: [
      ['name', 'Vault name', 'text', 'Documents'],
      ['start', 'Start date', 'date'],
    ],
    properties: [
      ['category', 'Category', 'select', ['Identity', 'Home', 'Money', 'Health', 'Work']],
      ['kept_at', 'Original kept at', 'text'],
      ['renew', 'Renew by', 'date'],
    ],
    views: [
      { kind: 'drive', name: 'Vault', layout: 'grid', columns: ['category'] },
      { kind: 'list', name: 'By category', groupBy: 'category', columns: ['kept_at', 'renew'] },
      {
        kind: 'query',
        name: 'Renew within 90 days',
        columns: ['category', 'renew'],
        filters: [{ property: 'renew', operator: 'within-next', value: '90' }],
      },
      { kind: 'calendar', name: 'Renewals', dateProperty: 'renew', sortBy: 'renew' },
    ],
    rows: [
      [
        'Passport',
        { category: 'Identity', kept_at: 'Desk drawer', renew: day(75) },
        'Attach a scan. Note the number and the issuing office.',
      ],
      [
        'Driving licence',
        { category: 'Identity', kept_at: 'Wallet', renew: day(400) },
        'Attach a scan. Note the number and the issuing office.',
      ],
      [
        'Tenancy agreement',
        { category: 'Home', kept_at: 'Blue folder', renew: day(120) },
        'Attach the signed copy. Note the notice period.',
      ],
      [
        'Home insurance',
        { category: 'Home', kept_at: 'Email', renew: day(30) },
        'Attach the policy. Note the claims line.',
      ],
      [
        'Tax return',
        { category: 'Money', kept_at: 'Blue folder', renew: day(200) },
        'Attach the filed return and the receipt.',
      ],
      [
        'Vaccination record',
        { category: 'Health', kept_at: 'Desk drawer' },
        'Attach a photo of every page.',
      ],
      [
        'Employment contract',
        { category: 'Work', kept_at: 'Email' },
        'Attach the signed copy. Note the notice period.',
      ],
      [
        'Warranty receipts',
        { category: 'Home', kept_at: 'Shoe box', renew: day(60) },
        'Attach a photo of each receipt before it fades.',
      ],
    ],
  },
  {
    key: 'nix.inbox',
    name: 'Inbox',
    description:
      'One place to drop everything before you decide what it is. Capture fast, then tick each line off as you file it.',
    inputs: [['name', 'Inbox name', 'text', 'Inbox']],
    properties: [
      ['done', 'Filed', 'checkbox'],
      ['kind', 'Kind', 'select', ['Task', 'Idea', 'Link', 'Question']],
      ['source', 'Where it came from', 'text'],
    ],
    views: [
      { kind: 'checklist', name: 'Inbox', doneProperty: 'done', columns: ['kind'] },
      { kind: 'form', name: 'Capture', columns: ['kind', 'source'] },
      {
        kind: 'query',
        name: 'Tasks to schedule',
        columns: ['source'],
        filters: [{ property: 'kind', operator: 'equals', value: 'Task' }],
      },
      {
        kind: 'board',
        name: 'By kind',
        groupBy: 'kind',
        groupOrder: ['Task', 'Idea', 'Link', 'Question'],
        columns: ['source'],
      },
    ],
    rows: [
      [
        'Call the dentist',
        { done: true, kind: 'Task', source: 'Reminder card' },
        'Anything you need to act on it.',
      ],
      [
        'Renew the library card',
        { done: true, kind: 'Task', source: 'Email' },
        'Anything you need to act on it.',
      ],
      [
        'Send the photos to the family',
        { done: false, kind: 'Task', source: 'Dinner on Sunday' },
        'Anything you need to act on it.',
      ],
      [
        'A weekly review that takes ten minutes',
        { done: false, kind: 'Idea', source: 'Shower thought' },
        'Anything you need to act on it.',
      ],
      [
        'Essay on keeping a commonplace book',
        { done: false, kind: 'Link', source: 'Newsletter' },
        'Paste the link and why it caught you.',
      ],
      [
        'Is the gym cheaper paid yearly?',
        { done: false, kind: 'Question', source: 'Bank statement' },
        'Anything you need to act on it.',
      ],
      [
        'Gift for the wedding',
        { done: false, kind: 'Task', source: 'Invitation' },
        'Anything you need to act on it.',
      ],
    ],
  },
  {
    key: 'nix.job-hunt',
    name: 'Job hunt',
    description:
      'Every application in one pipeline, from wishlist to offer, with its deadline and the people you spoke to.',
    inputs: [
      ['name', 'Search name', 'text', 'Job hunt'],
      ['start', 'Start date', 'date'],
    ],
    properties: [
      ['company', 'Company', 'text'],
      ['stage', 'Stage', 'select', ['Wishlist', 'Applied', 'Interview', 'Offer', 'Closed']],
      ['applied', 'Applied', 'date'],
      ['deadline', 'Next deadline', 'date'],
      ['salary', 'Salary (thousands)', 'number'],
    ],
    views: [
      {
        kind: 'board',
        name: 'Pipeline',
        groupBy: 'stage',
        groupOrder: ['Wishlist', 'Applied', 'Interview', 'Offer', 'Closed'],
        columns: ['company', 'deadline'],
      },
      {
        kind: 'sheet',
        name: 'All applications',
        columns: ['company', 'stage', 'applied', 'deadline', 'salary'],
      },
      {
        kind: 'timeline',
        name: 'Deadlines',
        dateProperty: 'applied',
        endDateProperty: 'deadline',
        mode: 'month',
        columns: ['stage'],
      },
      {
        kind: 'chart',
        name: 'By stage',
        groupBy: 'stage',
        groupOrder: ['Wishlist', 'Applied', 'Interview', 'Offer', 'Closed'],
      },
    ],
    rows: [
      [
        'Product designer',
        {
          company: 'Northwind',
          stage: 'Interview',
          applied: day(-14),
          deadline: day(3),
          salary: 70,
        },
        'The posting, who you spoke to, and what to prepare.',
      ],
      [
        'Senior designer',
        {
          company: 'Harbour Studio',
          stage: 'Interview',
          applied: day(-10),
          deadline: day(6),
          salary: 78,
        },
        'The posting, who you spoke to, and what to prepare.',
      ],
      [
        'Design lead',
        { company: 'Fieldnotes', stage: 'Applied', applied: day(-5), deadline: day(9), salary: 85 },
        'The posting, who you spoke to, and what to prepare.',
      ],
      [
        'UX researcher',
        { company: 'Lantern', stage: 'Applied', applied: day(-3), deadline: day(12), salary: 66 },
        'The posting, who you spoke to, and what to prepare.',
      ],
      [
        'Design systems engineer',
        { company: 'Kiln', stage: 'Wishlist', deadline: day(15), salary: 90 },
        'The posting, and why it is on the list.',
      ],
      [
        'Staff designer',
        { company: 'Meridian', stage: 'Offer', applied: day(-30), deadline: day(2), salary: 95 },
        'The offer, the questions left, and the date they need an answer.',
      ],
      [
        'Designer',
        { company: 'Old Mill', stage: 'Closed', applied: day(-40), salary: 60 },
        'What you learned from this one.',
      ],
    ],
  },
  {
    key: 'nix.meal-plan',
    name: 'Meal plan',
    description:
      'A week of meals as recipe cards, placed on a calendar, with a shopping checklist for what is missing.',
    inputs: [
      ['name', 'Plan name', 'text', 'Meal plan'],
      ['start', 'Week starting', 'date'],
    ],
    properties: [
      ['meal', 'Meal', 'select', ['Breakfast', 'Lunch', 'Dinner']],
      ['day', 'Day', 'date'],
      ['minutes', 'Minutes', 'number'],
      ['stocked', 'Ingredients at home', 'checkbox'],
    ],
    views: [
      { kind: 'gallery', name: 'Recipes', columns: ['meal'], cardSize: 'medium' },
      { kind: 'calendar', name: 'This week', dateProperty: 'day', sortBy: 'day' },
      { kind: 'checklist', name: 'Shopping', doneProperty: 'stocked', columns: ['meal'] },
      {
        kind: 'chart',
        name: 'Minutes by meal',
        groupBy: 'meal',
        measure: 'sum',
        measureProperty: 'minutes',
      },
    ],
    rows: [
      [
        'Overnight oats',
        { meal: 'Breakfast', day: day(0), minutes: 5, stocked: true },
        'Ingredients, then the steps.',
      ],
      [
        'Lentil soup',
        { meal: 'Lunch', day: day(0), minutes: 35, stocked: true },
        'Ingredients, then the steps.',
      ],
      [
        'Roast chicken and greens',
        { meal: 'Dinner', day: day(0), minutes: 70, stocked: false },
        'Ingredients, then the steps.',
      ],
      [
        'Chickpea salad',
        { meal: 'Lunch', day: day(1), minutes: 15, stocked: true },
        'Ingredients, then the steps.',
      ],
      [
        'Jollof rice',
        { meal: 'Dinner', day: day(1), minutes: 60, stocked: false },
        'Ingredients, then the steps.',
      ],
      [
        'Eggs on toast',
        { meal: 'Breakfast', day: day(2), minutes: 10, stocked: true },
        'Ingredients, then the steps.',
      ],
      [
        'Tomato pasta',
        { meal: 'Dinner', day: day(2), minutes: 25, stocked: true },
        'Ingredients, then the steps.',
      ],
      [
        'Fish tacos',
        { meal: 'Dinner', day: day(3), minutes: 30, stocked: false },
        'Ingredients, then the steps.',
      ],
      [
        'Vegetable curry',
        { meal: 'Dinner', day: day(4), minutes: 40, stocked: false },
        'Ingredients, then the steps.',
      ],
    ],
  },
  {
    key: 'nix.personal-dashboard',
    name: 'Personal dashboard',
    description:
      'What is on across the parts of your life: a chart of where the time goes, today as a checklist and the week on a calendar.',
    inputs: [
      ['name', 'Dashboard name', 'text', 'Dashboard'],
      ['start', 'Week starting', 'date'],
    ],
    properties: [
      ['area', 'Area', 'select', ['Work', 'Home', 'Health', 'Money']],
      ['status', 'Status', 'select', ['Next', 'Waiting', 'Done']],
      ['due', 'Due', 'date'],
      ['done', 'Done', 'checkbox'],
      ['minutes', 'Minutes', 'number'],
    ],
    views: [
      {
        kind: 'chart',
        name: 'Time by area',
        groupBy: 'area',
        groupOrder: ['Work', 'Home', 'Health', 'Money'],
        measure: 'sum',
        measureProperty: 'minutes',
      },
      { kind: 'checklist', name: 'Today', doneProperty: 'done', columns: ['area'] },
      { kind: 'calendar', name: 'Week', dateProperty: 'due', sortBy: 'due' },
      {
        kind: 'matrix',
        name: 'Area by status',
        groupBy: 'status',
        groupOrder: ['Next', 'Waiting', 'Done'],
        rowBy: 'area',
      },
      {
        kind: 'custom',
        name: 'Overview',
        program: [
          'root = Stack([heading, table])',
          'heading = Text("Everything on", "title")',
          'rows = Query("list_items", {parentId: $container}, {items: []})',
          'table = Table(["Title", "Type"], @Each(rows.items, "item", [item.title, item.type]), "Items in this dashboard")',
        ].join('\n'),
      },
    ],
    rows: [
      [
        'Write the project update',
        { area: 'Work', status: 'Next', due: day(0), done: false, minutes: 90 },
        'The next action, and what done looks like.',
      ],
      [
        'Review the budget',
        { area: 'Money', status: 'Next', due: day(1), done: false, minutes: 45 },
        'The next action, and what done looks like.',
      ],
      [
        'Morning run',
        { area: 'Health', status: 'Done', due: day(0), done: true, minutes: 40 },
        'The next action, and what done looks like.',
      ],
      [
        'Book the plumber',
        { area: 'Home', status: 'Waiting', due: day(2), done: false, minutes: 15 },
        'The next action, and what done looks like.',
      ],
      [
        'Prepare the workshop',
        { area: 'Work', status: 'Next', due: day(3), done: false, minutes: 120 },
        'The next action, and what done looks like.',
      ],
      [
        'Meal prep',
        { area: 'Home', status: 'Next', due: day(5), done: false, minutes: 60 },
        'The next action, and what done looks like.',
      ],
      [
        'Pay the electricity bill',
        { area: 'Money', status: 'Done', due: day(0), done: true, minutes: 10 },
        'The next action, and what done looks like.',
      ],
      [
        'Stretching',
        { area: 'Health', status: 'Next', due: day(4), done: false, minutes: 20 },
        'The next action, and what done looks like.',
      ],
    ],
  },
];
