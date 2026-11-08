/**
 * New project → Start from an example (v1.0 F6): goals like the ones Plenum is measured on
 * (bench/projects), ready to edit. Each one suits an empty folder.
 */
export interface Example {
  id: string;
  label: string;
  goal: string;
  design?: string;
  doneWhen: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'website',
    label: 'A website for a small business',
    goal: [
      'A website for Northwind Roasters, a small independent coffee roaster (make up the details).',
      'It should feel like a high-end brand, not a template: a home page with a strong hero, the coffees with',
      'tasting notes and prices, a page about how they roast, and a contact page with opening hours and a form',
      'that checks what you type. Plain HTML, CSS and JavaScript with no build step and no dependencies, so it',
      'works from any static web server. It must look right on phones and large screens, work with the keyboard',
      'and a screen reader, and respect reduced motion.',
    ].join('\n'),
    design: 'warm, editorial, generous whitespace, one accent colour',
    doneWhen: 'Every page works on a phone and a desktop, and the contact form checks its fields',
  },
  {
    id: 'recipes',
    label: 'A recipe book with a server',
    goal: [
      'A recipe book I run on my own computer: a Node.js server with a JSON API and a SQLite database, and a',
      'web page to browse, search, add and edit recipes, with a photo for each one if I have one. No npm',
      'packages: only node:http and node:sqlite. Searching finds recipes by title or ingredient, and a recipe',
      'can be scaled to a different number of servings.',
    ].join('\n'),
    doneWhen: 'The API and the page can add, edit, search, scale and delete recipes, with tests',
  },
  {
    id: 'dashboard',
    label: 'A sales dashboard',
    goal: [
      'A sales dashboard I open in a browser, from a CSV of orders (date, region, product, quantity, price).',
      'Totals for the chosen period, revenue over time, the best products and a comparison by region, with',
      'filters for the date range and region that update everything at once. Plain HTML, CSS and JavaScript,',
      'no frameworks and no build step. Charts are readable in light and dark mode and have a table view.',
    ].join('\n'),
    design: 'calm, clear, data first',
    doneWhen: 'The numbers match the CSV for any filter, and every chart has a table view',
  },
  {
    id: 'game',
    label: 'A browser game',
    goal: [
      'A small arcade game that runs in the browser: you steer a ship through an asteroid field, collecting',
      'stars for points while the field speeds up. Keyboard and touch controls, a pause key, a high score',
      'saved between visits, and sound you can turn off. Plain HTML, CSS and JavaScript on a canvas, no',
      'dependencies. The game logic lives in its own module so it can be tested without a browser.',
    ].join('\n'),
    design: 'playful, neon, arcade',
    doneWhen: 'The game plays start to game over, and its logic has tests',
  },
  {
    id: 'photos',
    label: 'A tool that tidies a photo folder',
    goal: [
      'A command-line tool I point at a folder of photos that finds duplicate copies (the same picture under',
      'different names) and moves them aside into a folder I can check, never deleting anything. It then',
      'sorts what is left into year and month folders by the date the photo was taken, and prints a summary.',
      'A dry run shows what it would do without changing anything.',
    ].join('\n'),
    doneWhen: 'Duplicates are moved aside, the rest sorted by date, with a dry run and tests',
  },
];
