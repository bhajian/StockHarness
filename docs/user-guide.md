# StockHarness user guide

This guide explains every page, tab and control in the StockHarness studio: what it is for, how to use it, how to
configure it, and what happens underneath. It is written from the code, so the labels match what you see on
screen. Examples use this deployment: FMP as the market-data provider, Google Gemini on Vertex AI as the models,
and the S&P 500 proxy as the research scope.

**How to read it.** Start with this overview and the first-day walkthrough. Then read the part you need:

1. [The app and the Build pages](#part-1-the-app-and-the-build-pages): signing in, the layout, Map, Harnesses,
   Playground, Skills, MCP connections, Knowledge
2. [Data](#part-2-data-layers-1-and-2): Datasets, the Catalog, Transforms, Pipelines, Health, and how syncs work
3. [Research, ideas and evaluations](#part-3-research-ideas-and-evaluations-layers-3-and-4): the research loop, gates and
   verdicts, the Ideas pages, evaluations and name subsets
4. [Simulations and the workspace](#part-4-simulations-and-the-workspace): Simulations, Inbox, Executions,
   Integrations, Settings, and everything as YAML

A [glossary](#glossary) at the end defines the terms.

## Contents

- **[Part 1: The app and the Build pages](#part-1-the-app-and-the-build-pages)**
  - [Getting in and the layout](#getting-in-and-the-layout)
  - [Map](#map)
  - [Harnesses](#harnesses)
  - [Playground](#playground)
  - [Skills](#skills)
  - [MCP connections](#mcp-connections)
  - [Knowledge](#knowledge)
- **[Part 2: Data (Layers 1 and 2)](#part-2-data-layers-1-and-2)**
  - [Key terms](#key-terms)
  - [Datasets](#datasets)
  - [How syncs work (Layer 1 underneath)](#how-syncs-work-layer-1-underneath)
  - [Catalog tab](#catalog-tab)
  - [Transforms tab](#transforms-tab)
  - [Pipelines tab](#pipelines-tab)
  - [Health tab](#health-tab)
  - [Questions and answers](#questions-and-answers)
- **[Part 3: Research, ideas and evaluations (Layers 3 and 4)](#part-3-research-ideas-and-evaluations-layers-3-and-4)**
  - [Research page](#research-page)
  - [How the research loop works](#how-the-research-loop-works)
  - [Gates and verdicts](#gates-and-verdicts)
  - [Ideas pages](#ideas-pages)
  - [Evaluations page](#evaluations-page)
  - [The strategy plugin contract](#the-strategy-plugin-contract)
  - [YAML and records](#yaml-and-records)
- **[Part 4: Simulations and the workspace](#part-4-simulations-and-the-workspace)**
  - [Simulations](#simulations)
  - [Inbox](#inbox)
  - [Executions](#executions)
  - [Integrations](#integrations)
  - [Settings](#settings)
  - [Everything as YAML](#everything-as-yaml)
  - [Worked example: Gemini on Vertex AI](#worked-example-gemini-on-vertex-ai)
- **[Glossary](#glossary)**

---

## What StockHarness is

StockHarness is a research platform for stock strategies. AI agents propose trading ideas, write them as code,
and test them on point-in-time data. A fixed evaluator scores the results, and fixed gates decide which ideas are
real. You watch, steer and judge everything from the studio.

It is built in five layers. Each one feeds the next:

| Layer              | What it is                                                                                                                     | Where you see it                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| **1. Data**        | Raw data synced from providers (FMP): prices, fundamentals, calendars, insider trades, news…                                   | Datasets → syncs                 |
| **2. Data prep**   | Python _transforms_ that turn raw data into clean, point-in-time tables (`prices_daily`, `universe_daily`, `features_ranked`…) | Datasets → Transforms, Pipelines |
| **3. Research**    | The _research loop_: agents (Theorist, Judge, Coder) propose, review and code ideas; the evaluator backtests them              | Research                         |
| **4. Ideas**       | Every idea with its debate, code, evaluations and verdict (successful, promising or failed)                                    | Ideas, Evaluations               |
| **5. Simulations** | Paper portfolios: one or more ideas traded together by a paper broker with costs, sizing and exits                             | Simulations                      |

The **Map** page shows these five columns on one screen, with counts and links, and tells you where to start.

### What makes the results trustworthy

Four rules run through the whole platform:

- **Point in time.** Every read is cut at the date being simulated. An idea scored on 2023-03-01 can only see data
  that was known on 2023-03-01. The Schema Catalog records when each table's rows become known.
- **A fixed evaluator.** Agents write the _signal_ (which stocks to rank highest). Fixed platform code does
  everything else: walking the dates, building the book, trading at the next day's close, paying costs, and
  scoring. Agents can't tune the scoring.
- **A locked holdout.** The last 18 months of data are hidden from research. Each idea gets one shot at them, at
  its verdict.
- **Every trial counts.** Each evaluation is a trial. The deflated Sharpe ratio corrects for how many trials the
  whole workspace has run, so a lucky result among many tries does not pass.

---

## Your first day: a walkthrough

A typical path, from nothing to a simulated idea:

1. **Check the data** (Datasets → Health). Each sync shows when it last ran. The badge in the top bar shows how
   fresh prices are, for example "Data fresh as of 2026-11-06 close".
2. **Check the models** (Settings → model providers). Test each provider with **Test**. For Gemini on Vertex AI,
   see the provider example in Part 4.
3. **Set up research** (Research → Setup). In order:
   1. Choose the scope (**S&P 500 proxy (top 500)**) and the evaluation years.
   2. Pick a model and skills for each role, and the number of Theorists per cycle.
   3. Choose the idea profiles, set a budget, and save.
4. **Start the loop.** Click **Start** to run hourly, or **Run a cycle now** for a single cycle. Follow it on
   Research → Cycles (one row per cycle, with each agent's steps and cost).
5. **Read the ideas** (Ideas). The default view lists successful and approved ideas. Switch to **Promising** for
   ideas that beat the S&P 500 but aren't proven yet, or **All** to see everything. Open an idea for its debate,
   code, runs and results.
6. **Look closer** on an idea's Results tab. Check the per-name table, and try **Find the names** to see whether
   the strategy works on a subset of stocks.
7. **Simulate** (Simulations → new simulation). Pick one or more ideas, the allocation, sizing and period, then
   **Run**. Check that a one-idea simulation reproduces its evaluation.
8. **Keep a copy.** Export the setup as YAML from any page that has the export button, or from Settings.

Every step is explained in detail in the parts below.

---

# Part 1: The app and the Build pages

This part covers the shell of the studio (signing in, the sidebar, the top bar) and the first six pages under
**Build** in the sidebar: **Map**, **Harnesses**, **Playground**, **Skills**, **MCP connections** and **Knowledge**.
The rest of Build (Datasets, Research, Ideas, Simulations) and the **Workspace** pages are in Parts 2 to 4.

A few terms come up on every page. Here they are once:

| Term                             | Meaning                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Harness**                      | A saved workflow: a graph of steps that starts at **Start**, runs agents, tools, code or branches, and ends at **Finish**. The studio calls it a harness; the API and database still call it a _workflow_ (`/api/workflows`, the `workflows` collection). Both names mean the same object. |
| **Node** (also _step_ or _card_) | One box on the harness canvas: Start, an AI agent, a Parallel group, a Python step, a Finish, and so on.                                                                                                                                                                                   |
| **Agent**                        | A language model with instructions, a budget, tools, knowledge and skills. In a harness it is an **AI agent** card.                                                                                                                                                                        |
| **MCP**                          | Model Context Protocol: the standard way agents reach outside tools. An _MCP server_ offers tools (for example `quote`, `query_collection`); an _MCP connection_ is StockHarness's saved address and credentials for one server. Every external tool in StockHarness is an MCP tool.       |
| **Skill**                        | A named block of instructions with a one-line "when to use it". An agent sees only the one-liners and loads the full instructions when a request matches.                                                                                                                                  |
| **Run**                          | One execution of a harness or agent. Every run gets an id, a status and a trace, and appears under **Executions**.                                                                                                                                                                         |
| **Knowledge base**               | A set of notes and files indexed in a vector store so agents can search them by meaning.                                                                                                                                                                                                   |

---

## Getting in and the layout

### First-time setup and sign-in

When you open the studio, it first asks the API whether any account exists (`GET /api/auth/status`). While it
checks, you see a loading screen with the text _Opening your studio…_.

The sign-in page has a story panel on the left ("Agents that get things done.") and the form on the right.

**First-time setup** (no administrator exists yet). The heading reads **Make yourself at home.** and the subtitle
_Create the first local administrator account for your studio._

| Field                           | What it does                                                                                                                                                                                                                                                       | Example           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| **Your name**                   | Your display name (1 to 100 characters). Its first letter becomes your avatar in the sidebar.                                                                                                                                                                      | `Behnam`          |
| **Setup token**                 | Proves you control the installation. It must equal the `SETUP_TOKEN` of the deployment (generated by `./start.sh` into the local `.env`; on EKS it lives in the deployment's secrets). A wrong value gives _Invalid setup token. Find it in your local .env file._ | (hidden)          |
| **Email address**               | Your sign-in name.                                                                                                                                                                                                                                                 | `you@example.com` |
| **Password**                    | 12 to 256 characters.                                                                                                                                                                                                                                              | —                 |
| **Create your studio** (button) | Creates the account and signs you in.                                                                                                                                                                                                                              | —                 |

What happens: the API creates exactly one account with a fixed id, role **admin**, and its own workspace
(_tenant_). Because the id is fixed, a second setup attempt fails with _Studio setup is already complete_. Setup
attempts are rate-limited to 10 per 10 minutes per address.

**Normal sign-in.** The heading reads **Welcome back.** with **Email address**, **Password** and the **Sign in**
button. A wrong email or password gives _Invalid email or password_. Logins are rate-limited (20 per 10 minutes per
address by default, `LOGIN_RATE_LIMIT`).

A successful sign-in sets an HTTP-only session cookie (`agentic_session`) that lasts **7 days**. Changing your
password in Settings signs out every other session.

**How to sign in for the first time**

1. Find the setup token for this installation (the `SETUP_TOKEN` value).
2. Open the studio URL. You should see **Make yourself at home.**
3. Fill in **Your name**, **Setup token**, **Email address** and a password of at least 12 characters.
4. Click **Create your studio**. You land on the Harnesses page.

### The layout

The screen has three parts: the **sidebar** on the left, the **top bar** across the top, and the page content.

#### The sidebar

From top to bottom:

| Element                              | What it does                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **openharness.** logo                | Goes to the Harnesses page (the studio's home).                                                                                                                                                                                                                                             |
| **Workspace switcher**               | Shows your initial, the workspace name (default _Team workspace_) and the words _Shared workspace_. It is a display only: clicking it does nothing, because an installation has one workspace per account. Rename the workspace in **Settings → Workspace → Workspace name** (admins only). |
| **Build** (label)                    | The building pages: Map, Harnesses, Playground, Skills, MCP connections, Knowledge, Datasets, Research, Ideas, Simulations.                                                                                                                                                                 |
| **Workspace** (label)                | Inbox, Executions, Integrations, Settings. **Inbox** shows a count in brackets, for example _Inbox (2)_, when people's input or approvals are waiting. The count refreshes every 5 seconds.                                                                                                 |
| **Profile** (name and email, bottom) | Opens Settings.                                                                                                                                                                                                                                                                             |
| **Sign out**                         | Ends the session on the server and returns to the sign-in page.                                                                                                                                                                                                                             |

Each sidebar item has its own URL, so you can bookmark pages or use the browser's back button:

| Sidebar item    | URL path                                                            |
| --------------- | ------------------------------------------------------------------- |
| Map             | `/map`                                                              |
| Harnesses       | `/harnesses` (also the page for `/`)                                |
| Playground      | `/playground`                                                       |
| Skills          | `/skills`                                                           |
| MCP connections | `/connections`                                                      |
| Knowledge       | `/knowledge` (Documents) and `/knowledge/collections` (Collections) |
| Datasets        | `/datasets/syncs`                                                   |

On a narrow screen the sidebar is hidden; the menu button (**Toggle navigation**) at the left of the top bar opens it.

#### The top bar

| Element                  | What it shows                                                                                                                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Breadcrumb**           | The workspace name, then the page name (for example _Team workspace › Harnesses_). On the Playground the page name is replaced by the harness selector (see [Playground](#playground)). On Knowledge, the **Documents** / **Collections** tabs sit here. |
| **Page actions**         | Some pages put their main button here: **New knowledge base** on Knowledge → Documents; the export, new-conversation and trace buttons on the Playground.                                                                                                |
| **Data-freshness badge** | A coloured dot and one line about the state of your data (below). Click it to open **Datasets → Health**.                                                                                                                                                |
| **Online / Connecting…** | The API health check (`GET /api/health`, every 30 seconds). **Online** with a green dot means the API answers; **Connecting…** means it does not.                                                                                                        |

If a new version of the studio has been deployed while you have it open, a banner appears: _A new version of
OpenHarness is available. Save your work, then reload to use it._ with a **Reload** button. The studio checks for
this every minute and whenever the tab regains focus.

Errors from any action appear in a red bar under the top bar; the **×** (_Dismiss error_) closes it.

#### The data-freshness badge

The badge answers one question: can I trust today's data? It calls `GET /api/datasets/health?days=20` when the
page opens and every 5 minutes, and shows the _indicator_ the server computes. Until the first call succeeds, no
badge is shown; a later failed call keeps the last value on screen.

The server picks the first rule that applies:

| Colour | Text you see                             | When                                                                                                                  |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Red    | `Layer 2 blocked at <pipeline> › <step>` | A pipeline's latest run has a step that is `blocked`, `gate_failed` or `failed`.                                      |
| Red    | `Layer 2 blocked: <transform> failed`    | A transform's latest run failed.                                                                                      |
| Amber  | `N sync(s) late`                         | An enabled dataset sync whose next run is more than one hour overdue (the dispatcher should already have started it). |
| Amber  | `N collection(s) stale`                  | A collection has gone longer than its cadence allows without an update (see below).                                   |
| Green  | `Data fresh as of 2026-11-09 close`      | Nothing above applies. The date is the latest date in `prices_daily` (or `eod_prices`).                               |
| Green  | `Data fresh`                             | Nothing above applies and no price collection has a date yet.                                                         |

How "stale" is decided for a collection:

- **Age.** A collection is stale when its last update is older than its cadence allows: 1 day for hourly or
  minute cadences, 3 days for daily ones and "after …" triggers, 10 days for weekly, 40 days for monthly,
  `2 × N + 1` days for "every N days", 8 days when there is no cadence. For a numeric schedule the limit is
  2.5 times the interval, at least one day.
- **Missing sessions.** For a daily, dated collection, the server also counts expected NYSE sessions (from
  `trading_calendar`, or weekdays if there is no calendar) after the latest date. More than 3 missing sessions
  makes it stale even if it was updated recently.
- A collection whose last sync failed counts as **failed**, not stale.

**Example.** The FMP end-of-day sync runs after the close. On Tuesday morning the badge reads
_Data fresh as of 2026-11-09 close_. If the sync's next run is still pending at 11:00 the next day, the badge turns
amber with _1 sync late_. Click it to see which one on Datasets → Health.

---

## Map

The Map is the one-page picture of the whole workspace, left to right: data comes in, is prepared point in time,
the research agents turn it into ideas, ideas are evaluated, and the good ones are simulated. It also has a
_Start here_ checklist that tells you which link in the chain needs attention. Every box is clickable and opens
the page where that thing is changed.

**How to get there:** sidebar **Map**, URL `/map`.

**Underneath:** the page calls `GET /api/map` when it opens and every 30 seconds. The server
(`packages/core/src/workspaceMap.ts`) reads your dataset syncs, transforms, the schema catalog, the research
settings and the Research loop harness, and counts theories, evaluations and simulations. Nothing on the Map is
stored; it is always computed fresh.

### Start here checklist

A numbered list of six steps. Done steps have a filled check; the first step that is not done is highlighted and
labelled **start here**. Click a step to open its page.

| #   | Step                                 | Done when                                                        | Detail line shows                                                                        | Opens                  |
| --- | ------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------- |
| 1   | **Data is syncing**                  | At least one sync is on a schedule and none is failing or paused | `N syncs on a schedule`, or `N syncs need attention: <names>`                            | `/datasets/syncs`      |
| 2   | **Data is prepared (point in time)** | At least one transform exists and none failed on its last run    | `N transforms keep M collections current`, or `N transforms failed last time: <names>`   | `/datasets/transforms` |
| 3   | **Research is set up**               | The Research loop harness exists                                 | `5 agents · scope: the 500 largest US stocks by market cap on each date (S&P 500 proxy)` | `/research/setup`      |
| 4   | **Research is running**              | Set up, not paused, and the harness has a schedule               | `Every hour`, or `Paused`                                                                | `/research`            |
| 5   | **Ideas are coming out**             | At least one theory exists                                       | `N ideas · S successful · P promising · F failed · I in progress`                        | `/ideas?show=all`      |
| 6   | **An idea has been simulated**       | At least one simulation exists                                   | `N simulations`, or `Open an idea and press Simulate`                                    | `/simulations`         |

### The five columns

Each column has a numbered header you can click to open its page, and an arrow between columns naming what flows
across (_raw collections_, _point-in-time data_, _theories_, _approved ideas_).

#### 1. Data sources — "Layer 1 · synced from FMP"

A summary line (`N syncs · M on a schedule · K need attention`) and up to 8 sync cards; failing and paused syncs
are listed first. **Show all N** expands the list (**Show fewer** collapses it).

Each card shows the sync name, a status pill, the target collection with its row count, when it runs, and the
error or pause reason when there is one. Click a card to open that sync.

| Status    | Meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `ok`      | Enabled, on a schedule, last run succeeded.                                 |
| `failing` | The last run recorded an error.                                             |
| `paused`  | The sync paused itself (the reason is shown, for example a provider quota). |
| `off`     | The sync is disabled.                                                       |
| `manual`  | Enabled but not scheduled: _Only when run by hand_.                         |

Schedules are written in plain words, for example _Every day at 18:30_ or _Every 6 hours_.

#### 2. Data prep — "Layer 2 · point-in-time collections"

One card per Layer 2 transform, ordered so that a transform comes after the ones it waits for. Each card shows:

- the transform name (click to open it) and the status of its last run, or **never ran**;
- **reads** — the collections it takes as input;
- **writes** — its output collections, each a link to the catalog, with row count and latest date, for example
  `features_ranked (1,204,880 rows, to 2026-11-07)`;
- when it runs, for example _Automatically, after the "FMP EOD prices" sync finishes_;
- _last run … · N rows written_.

#### 3. Research setup — "Layer 4 · the agents"

If research is not installed, a card says **Not set up yet** with a **Set up research** button.

Once installed:

- **Scope** card: the evaluation scope in words. In this deployment: _the 500 largest US stocks by market cap on
  each date (S&P 500 proxy)_, then _N years before the holdout · Every hour_ (and _· paused_ when paused).
- **Data the agents can read**: how many collections the research data tools serve and the first ten names. These
  are the catalog collections marked point-in-time (`pit`) or `static`.
- One card per agent: name, `model <model id>`, the skills it loads and its tool count. Parallel Theorists with the
  same model and skills are shown as one card, for example **Theorist ×2**. Clicking opens Research → How it works.
- _spend today $X.XX · $Y of $Z cap_ when a spend cap is set.

**Example.** With two Theorists on Gemini-flash-3-8 you would see _Theorist ×2 · model `gemini-3.8-flash` ·
strategy-library, read-the-catalog · 8 tools_, then _Judge (pre-code)_, _Coder_, _Judge (post-result)_.

> In this deployment (2026-11-10): the Theorist and the Coder use **Gemini-4-pro** (`gemini-4-argon`) and the Judge
> uses **Gemini-flash-3-8** (`gemini-3.8-flash`). The models are set in Research → Setup and shown on these cards.

#### 4. Ideas — "theories, reviewed and judged"

A big number (all theories) and the counts per outcome: successful, promising, failed, and _in progress_ (every
status between draft and post-review). A second card, **Evaluations**, shows _N runs of the trusted evaluator ·
M one-shot holdouts_.

#### 5. Simulations — "ideas run as a book"

The number of simulations and the latest one: _last: <name> · <status> · Sharpe 1.12_. Without any:
_Open an idea and press Simulate._

### How to use the Map

1. Open **Map** after a deployment or in the morning.
2. Read the checklist top to bottom. The step marked **start here** is where to look first.
3. Click a failing sync card to open it, or a transform's output to check its rows.
4. Return to the Map; it refreshes every 30 seconds.

---

## Harnesses

A harness is a saved, runnable workflow: steps connected left to right, from Start to Finish. Agents, tools,
Python code, branches, human reviews and emails are all steps. The **Research loop** that produces your ideas is a
harness, as are helpers such as _Financial Market Analysis_. This page lists them, creates them and opens the
visual editor.

**How to get there:** sidebar **Harnesses**, URL `/harnesses`. It is also the start page.

### The Harnesses list

At the top, the title **Harnesses** with three buttons:

| Button             | What it does                                                                       |
| ------------------ | ---------------------------------------------------------------------------------- |
| **Export**         | Downloads all harnesses as one YAML file (`stockharness-harness-YYYY-MM-DD.yaml`). |
| **Import**         | Opens _Import Harnesses from YAML_ (see [Importing YAML](#importing-yaml)).        |
| **Create harness** | Opens the template picker (_Start a harness_).                                     |

Then three summary cards:

| Card                | Number                | Small line                       |
| ------------------- | --------------------- | -------------------------------- |
| **Harnesses**       | Total harnesses       | `N enabled`                      |
| **MCP connections** | Total connections     | `N tools` (all discovered tools) |
| **Knowledge bases** | Total knowledge bases | `N scheduled harnesses`          |

Below, **All harnesses N** and a **Search harnesses…** box that filters by name.

Each harness card shows:

- an **enabled** / **disabled** pill and a bin icon (_Delete <name>_, asks for confirmation);
- the name (click to open the editor) and description;
- a mini flow of the first six steps (icons for start, agent, tool, finish, others) and
  `N agents · M steps`;
- the footer: the schedule in words (for example **Every hour**) or the last-update date, a **Run** button that
  opens the Playground with this harness (disabled for a disabled harness), and **Open**.

**Example.** The Research loop card reads _5 agents · 8 steps_ and _Every hour_.

#### Importing YAML

The import dialog is shared by every list page that has **Import**.

| Field                   | What it does                                                                                                                                        | Example                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **YAML file**           | Pick a `.yaml`, `.yml` or `.json` file: a StockHarness export, a Datasets export or a `deploy/config-io` file.                                      | `harnesses.yaml`                |
| **Or paste YAML**       | Paste instead of picking a file.                                                                                                                    | `apiVersion: stockharness/v1` … |
| **Mode**                | **Merge**: create new objects and update ones with the same name. **Replace**: also remove objects of these kinds that are not in the file.         | Merge                           |
| **Kind of a bare list** | Only for older config-io files that are a plain list: **Auto (stockharness/v1 objects)**, **Skills**, **Agents**, **Harnesses**, **Dataset syncs**. | Auto                            |
| **Preview**             | Dry run: lists _Errors_, _Create (N)_, _Update (N)_, _Remove (N)_ and _Unchanged_. Nothing is written.                                              | —                               |
| **Apply import**        | Applies exactly what was last previewed. Disabled until you preview, and while there are errors. It turns red when the plan removes objects.        | —                               |

Objects are matched by kind and name. References to connections, model providers, skills and knowledge bases are
by **name** and must already exist here, because those objects hold secrets and are never in the file. Data rows
are never changed.

A harness in YAML looks like this (trimmed from `deploy/config-io/exports/harnesses.yaml`):

```yaml
apiVersion: stockharness/v1
kind: Harness
metadata:
  name: Financial Market Analysis
spec:
  enabled: true
  startAt: start
  nodes:
    - { id: start, name: Start, type: start, next: assistant }
    - id: assistant
      name: Tool assistant
      type: agent
      config:
        systemPrompt: Use your attached MCP tools to handle the request. ...
        providerId: { $ref: { type: providers, name: Gemini-flash-3-8 } }
        skillIds: [{ $ref: { type: skills, name: stock } }]
        effort: medium
      prompt: '{{input}}'
      next: finish
    - { id: finish, name: Finish, type: finish, template: '{{last}}' }
  resources:
    - id: mcp_9547656e
      name: FMP
      type: mcp
      connectionId: { $ref: { type: connections, name: FMP } }
      tools: [quote, statements, news, technicalIndicators, ...]
  bindings:
    - { agentNodeId: assistant, resourceId: mcp_9547656e }
  maxSteps: 100
  resumePolicy: safe
```

### Creating a harness: "Start a harness"

**Create harness** opens a three-stage dialog: _Choose a template → Connect resources → Edit on the canvas_.

**Stage 1, Pick a starting point.** Nine templates:

| Template                         | What it builds                                                                                                         | Shape                                                  | Needs                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------- |
| **Knowledge research**           | Answers from your documents, with citations                                                                            | Start → Researcher → Finish                            | a knowledge base            |
| **MCP tool assistant** (default) | An agent with the tools it needs                                                                                       | Start → Tool assistant → Finish                        | an MCP connection and tools |
| **Data chatbot**                 | Read-only answers from MongoDB collections (`prices_daily`, `features_daily`, `securities`, `signals`) with cited rows | Start → Data analyst → Finish                          | an MCP connection and tools |
| **Research and review**          | A researcher, then a reviewer checks it                                                                                | Start → Researcher → Reviewer → Finish                 | a knowledge base            |
| **Plan, research, write**        | Planner, researcher, writer                                                                                            | Start → Planner → Researcher → Writer → Finish         | an MCP connection and tools |
| **Route to a specialist**        | Triage agent and a condition pick a specialist                                                                         | Start → Triage → Condition → Specialist A / B → Finish | —                           |
| **Research and email**           | Analyst with tools, then the result is emailed                                                                         | Start → Analyst → Email → Finish                       | an MCP connection and tools |
| **Machine operator**             | Runs commands on one of your enrolled machines                                                                         | Start → Machine operator → Finish                      | a machine                   |
| **Blank canvas**                 | Start and Finish only                                                                                                  | Start → Finish                                         | —                           |

**Stage 2, Connect resources** (skipped for Blank canvas):

| Field                          | What it does                                                                                                                                           | Example                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| **Harness name**               | The name. Must be unique in the workspace.                                                                                                             | `FMP quote helper`                              |
| **Model provider**             | The model for the template's agents. **Add model provider** creates one in place; **Edit selected provider** edits it.                                 | `Gemini-flash-3-8 · gemini-3.8-flash · default` |
| **Knowledge base**             | For the knowledge templates.                                                                                                                           | `Research notes`                                |
| **MCP connection** + tool list | For tool templates: pick a connection, then tick tools (**Select all**, **Clear**, filter with _Find a tool…_). **Discover tools** refreshes the list. | `FMP`, tick `quote`, `news`                     |
| **Machine**                    | Machine operator only.                                                                                                                                 | —                                               |

**Open canvas** builds the draft and opens the editor. Nothing is saved until you click **Save** there.

### The harness editor

The editor fills the screen. Its header, left to right:

| Control                               | What it does                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **×** (_Close harness editor_)        | Closes without saving.                                                                                                              |
| Name field                            | The harness name. Under it: _Saved_ / _Unsaved_ · `N steps` · the schedule in words.                                                |
| Undo / Redo                           | Undo or redo graph changes (also Ctrl/⌘+Z and Shift+Ctrl/⌘+Z).                                                                      |
| **Canvas** / **YAML**                 | Switch between the visual editor and the raw YAML. Switching back from YAML validates it and refuses invalid YAML with the reasons. |
| **Settings**                          | Opens _Harness settings_ (description, step budget, crash policy, memory, schedule).                                                |
| **Use in your app**                   | Shows `curl` examples to start a run and read its result through the API (save first). **Open Integrations** leads to API keys.     |
| Download icon (_Export harness YAML_) | Downloads this harness as `workflow.yaml`.                                                                                          |
| **Save & test**                       | Saves, closes and opens the Playground with this harness selected.                                                                  |
| Save state                            | _Saving…_, _Unsaved changes_ or _All changes saved_.                                                                                |
| **Save**                              | Validates and saves.                                                                                                                |

Saving checks the whole graph (see [Validation rules](#validation-rules)) and shows up to five problems in words,
for example _"FMP" has no tools selected. Double-click the card and choose at least one tool, or remove it._
If someone else saved the same harness since you opened it, you get _This workflow was changed by a teammate.
Close and reopen it before saving._

#### The toolbox (left)

_Build your harness: Click a step to add it after the selected card. Attach tools and knowledge to an agent._
A search box (_Find a component…_) filters everything below.

- **Steps**: the eight step types (table below). Click one to add it after the selected card, or drag it onto the
  canvas.
- **MCP tools**: one entry per enabled connection with its tool count (_No tools discovered_ when empty). The
  **+** (_Connect an MCP server_) opens the connection form. Click or drag one onto an agent to attach it.
- **Machines**: enrolled machines (only if you have any).
- **Knowledge**: one entry per knowledge base (_Reference documents (read only)_). The **+** creates one.
- **Memory & learning**: **Set up memory** (or **Manage memory**) opens Harness settings.

#### The canvas

Cards are joined by their ports:

- **In** (left) and **Next** (right) carry the execution order. Drag from a card's Next to the next card's In.
- A **Condition** or **Human review** card has two exits, **Yes** and **No**.
- An **AI agent** card has two bottom ports, **Tools** (MCP tools cards) and **Knowledge** (knowledge cards), and
  a top port for a guardrail (safety policy).
- A **Parallel agents** card has a bottom **Runs** port; connect it to each agent card it should run.

Click a card to select it; a bar at the bottom shows its type and name with **Settings** and a bin (_Delete
selected component_). Double-click a card, click its gear, or press **Enter** to open its settings. **Delete** or
**Backspace** removes the selected card or link; a selected link shows **Disconnect**. **Auto layout** tidies the
graph. A card that is not ready shows a warning band, for example _Choose a model_, _Select tools_, _Choose
agents_, _Set the recipient_, _Write the code_.

When you remove a card, the step before it is reconnected to the step after it, and tools or knowledge cards used
only by that agent are removed too. Start and the last Finish cannot be deleted (_Keep one Start and Finish in the
harness._).

#### Node types

| Step (toolbox label) | Hint                      | What it does                                                                                                                                                                                                                      | Main settings                                                                                                                                                                             |
| -------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Start**            | —                         | Entry point. Runs start here from the Playground, the API, a webhook or a schedule. Its message is `{{input}}`.                                                                                                                   | **First step**; buttons **Schedule** and **Use in your app**                                                                                                                              |
| **AI agent**         | Reasons and acts          | A model with instructions, tools, knowledge and skills.                                                                                                                                                                           | Agent settings (below), **Message to this agent**, **Tools & knowledge**, **Next step**                                                                                                   |
| **Human review**     | Pause for approval        | Pauses the run until a person approves or rejects in the Inbox.                                                                                                                                                                   | **Review prompt**, **Result to review** (default `{{last}}`), **When approved**, **When rejected**                                                                                        |
| **Condition**        | Yes / no branch           | Compares a value and branches.                                                                                                                                                                                                    | **Value**, **Comparison** (`equals`, `notEquals`, `contains`, `truthy`, `greaterThan`), **Compare with**, **When yes**, **When no**                                                       |
| **Parallel agents**  | Agents together           | Runs several agent cards at the same time with the same message.                                                                                                                                                                  | **Message to each agent**, **Agents that run together** (tick cards), **New agent in this group**, _Saved agents_                                                                         |
| **MCP action**       | One tool call             | Calls one MCP tool with fixed arguments, no model involved.                                                                                                                                                                       | **MCP server**, **Tool**, arguments as JSON (checked against the tool's schema)                                                                                                           |
| **Python code**      | Run Python in a container | Runs Python 3.12 in a fresh executor container with numpy, pandas, polars, duckdb, scipy, scikit-learn, statsmodels, TA-Lib. `import oh` reads and writes the workspace's collections; `oh.result(...)` becomes the step's value. | **Python 3.12** code, **Parameters (JSON)** (as `oh.params`), **Secrets** (names from Settings → Python secrets, e.g. `FMP_API_KEY`), **Time limit (seconds)** (0 = installation default) |
| **Send email**       | Send the result           | Sends an email through Settings → Email.                                                                                                                                                                                          | **To** (comma-separated, templates allowed), **Subject** (default `{{input}}`), **Body** (default `{{last}}`)                                                                             |
| **Finish**           | Return a result           | Ends the run and returns the **Final response**.                                                                                                                                                                                  | **Final response** (default `{{last}}`)                                                                                                                                                   |

Two more cards are _resources_, attached to agents rather than placed in the execution path:

| Card          | What it does                                        | Settings                                                                                                                         |
| ------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **MCP tools** | Grants an agent a set of tools from one connection. | **MCP connection**, the tool checklist, **Used by** (which agents). For a MongoDB connection, **Collections** bindings (below).  |
| **Knowledge** | Gives an agent a knowledge base to search.          | **Knowledge base**, **Use as harness long-term memory**, **Used by**. Reference knowledge is read only unless memory is enabled. |

A **NeMo Guardrail** card can also be attached to an agent's top port (**Guardrail policy**).

**Templates in prompts.** Text fields that say so can use placeholders, filled in when the step runs:

| Placeholder           | Value                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `{{input}}`           | The run's input message.                                                                                         |
| `{{last}}`            | The previous step's result. After a Parallel step it is a JSON list of `{agentId, name, output}`, one per agent. |
| `{{steps.<id>}}`      | The result of any earlier step by its id, for example `{{steps.judge_pre}}`.                                     |
| `{{payload.<field>}}` | A field of the JSON payload sent with an API or webhook run, for example `{{payload.ticker}}`.                   |

An unknown placeholder makes the step fail with _Unknown template value_.

**Collection bindings (MongoDB tools only).** By default an agent with MongoDB tools may use _every_ collection in
the database, including deletes; the editor warns _Database-wide grant…_. **Bind a collection** limits it:

| Field                                   | What it does                                                                | Example                                     |
| --------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| **Collection**                          | The collection.                                                             | `prices_daily`                              |
| **Max rows per read**                   | Most rows a read returns.                                                   | `500`                                       |
| `read` / `insert` / `update` / `delete` | Permissions.                                                                | `read` only                                 |
| **enforce as of**                       | Cuts reads at the session's as-of date with the collection's known-at rule. | on                                          |
| **approve writes**                      | Asks a person before inserts, updates, deletes.                             | on                                          |
| **Fixed filter (JSON, optional)**       | Always added to reads, updates and deletes.                                 | `{ "symbol": { "$in": ["AAPL", "MSFT"] } }` |
| **Only these fields (optional)**        | Columns returned by reads.                                                  | `symbol, date, close`                       |

#### Agent settings

Opening an AI agent card shows **Name**, then four tabs, then the node-level fields.

**General**

| Field              | What it does                                                                                                                                   | Example                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Model provider** | The chat model. **Add model provider** / **Edit selected provider** open the provider form.                                                    | `Gemini-4-pro · gemini-4-argon` |
| **Vision model**   | Used for turns that include images.                                                                                                            | `Gemini-flash-vision`           |
| **Template**       | _Start from a template…_: fills instructions and pattern from a recipe (General assistant, Researcher, Planner, Reflective writer, Reviewer…). | —                               |
| **Instructions**   | The system prompt (up to 32,000 characters).                                                                                                   | `Use your attached MCP tools…`  |
| **Timezone**       | Clock for "today" and relative dates. Empty: the requester's browser or API timezone, then the harness schedule's, then UTC.                   | `America/New_York`              |

**Reasoning**

| Field                 | What it does                                                                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Effort**            | One click sets turns, tokens, time and pattern passes: **Light** (4 turns · 30k tokens · 90 s), **Medium** (12 · 120k · 5 min, the default), **High** (24 · 400k · 10 min), **Extra high** (36 · 1M · 15 min), **Max** (120 · 5M · 1 hour), **Auto** (picks light, medium or high per request). |
| **Sub-agents**        | _Can hand focused tasks to sub-agents…_; **Sub-agents per run** (default 4).                                                                                                                                                                                                                    |
| **Reasoning pattern** | **ReAct** (reason, call tools, answer; the default), **Plan and execute** (**Maximum plan steps**), **Reflection** (draft, critique, revise; **Critique rounds**, **Judge model**), **Autonomous loop** (**Maximum iterations**, 0 = until done; **Done marker**, default `DONE`).              |
| **Limits**            | _Compress context early and save displaced evidence in task memory_; **Turns per pass**, **Token budget**, **Time limit (seconds)**. 0 means no limit. Hidden for Auto effort.                                                                                                                  |

**Knowledge**

| Field                                | What it does                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Long-term memory**                 | A knowledge base used as this agent's persistent notebook. Default: the harness memory, then the first attached knowledge base. |
| **Learn from feedback and failures** | Turns feedback and failures into lessons recalled in later runs.                                                                |
| **Skills**                           | Tick the skills this agent may load (up to 20). **New skill** creates one in place and ticks it.                                |

**Safety & human input**

| Field                                          | What it does                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Human input** → **Allow questions**          | The agent may pause to ask you a question (answer in the Inbox or Playground). On by default.                                                    |
| **Python code** → **Can run Python it writes** | Gives the agent the `run_python` tool. Then: **Ask a human to approve the code before each run**, **Seconds per job**, **Secrets for the code**. |
| **Tool approvals**                             | **No approval required**, **Ask for risky tools** (tools without a read-only annotation), **Ask for every MCP tool**.                            |
| **Approval timeout (minutes)**                 | Default 1,440 (24 hours).                                                                                                                        |
| **Timeout action**                             | **Deny**, **Continue without new input**, **Escalate to administrators**.                                                                        |
| **Email authorized approvers**                 | Sends an email when approval is needed.                                                                                                          |

Below the tabs: **Message to this agent** (default `{{input}}`; _`{{input}}` is the run input, `{{last}}` the
previous step_), the **Tools & knowledge** list with **+ MCP tools** / **+ Knowledge**, and **Next step**.

#### Harness settings

| Field                                         | What it does                                                                                                                                                                        | Example            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **Description**                               | Shown on the card.                                                                                                                                                                  | —                  |
| **Step budget**                               | Node visits per run, the stop for loops. 0 = unlimited. Default 100.                                                                                                                | `200`              |
| **If a runner crashes**                       | **Resume when safe** (resume unless a tool, Python or email step was in flight), **Always resume**, **Never resume** (mark the run interrupted).                                    | Resume when safe   |
| **Harness enabled**                           | A disabled harness cannot run and its schedule does not fire.                                                                                                                       | on                 |
| **Long-term memory → Knowledge workspace**    | A knowledge base where each run's task, result and outcome are saved; agents can also write findings there. **Task memory only** keeps nothing beyond the run's temporary notebook. | `Task memory only` |
| _Save tool results in temporary task memory…_ | Large tool results go to the task notebook; only an excerpt stays in context.                                                                                                       | on                 |
| _Learn from experience…_                      | Feedback and failures become lessons in `experience/`, recalled in later runs.                                                                                                      | off                |
| **Schedule**                                  | See below.                                                                                                                                                                          | Every hour         |

#### Schedules

**Run on a schedule** turns it on and shows the result in words.

| Field               | What it does                                                                                                                                                              | Example                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **How often**       | **Every minute**, **Every 5 minutes**, **Every 15 minutes**, **Every 30 minutes**, **Every hour**, **Every 6 hours**, **Every day**, **Every week**, **Custom interval**. | Every hour                 |
| **Every (minutes)** | For Custom interval: 1 to 525,600.                                                                                                                                        | `90`                       |
| **On**              | For Every week: the weekday.                                                                                                                                              | Monday                     |
| **At**              | For daily or longer: the wall-clock time.                                                                                                                                 | `18:30`                    |
| **Time zone**       | For daily or longer. The list offers your browser's zone and UTC.                                                                                                         | `America/New_York`         |
| **Message to send** | The run's `{{input}}`. Default _Run the scheduled task._                                                                                                                  | `Scheduled research cycle` |
| _Next run …_        | When it fires next (shown after saving).                                                                                                                                  | —                          |

How the schedule dispatcher works (the API checks every 3 seconds):

- **Interval schedules** (under a day, or a day or more without **At**) fire, then the next run is set to _now +
  interval_. They are not aligned to the clock: an hourly harness saved at 10:17 runs at about 10:17, 11:17, 12:17.
- **Daily and weekly schedules with At** wait for that wall-clock time in the chosen zone (DST-aware) instead of
  firing the moment you save.
- **Changing the schedule** clears the planned next run, so an interval schedule fires on the next check.
- **No overlap.** If an earlier run of the same harness is still _queued_ or _running_, the slot is skipped and the
  next one is planned an interval later. A run waiting for a person does not block. With an hourly schedule and a
  cycle that takes 70 minutes, the next cycle starts about two hours after the previous one.
- **Each slot runs once.** Every scheduled run has a key made of the harness id and the planned time, so restarts or
  several API instances never start the same slot twice.
- **Until.** A schedule with an end time (set from Research → Setup for the research loop) turns itself off after
  that moment.
- **Errors.** If a run cannot be created (for example a missing model), the dispatcher retries a minute later and
  shows the error under the schedule.
- The workspace also has a cap of active runs (20 by default, `MAX_ACTIVE_RUNS`); above it new runs are refused with
  _Too many active runs_.

Schedules only fire for enabled harnesses. Runs you start by hand (Playground, API) are not blocked by the no-overlap
rule; only the schedule is.

#### What happens when a run starts

1. The server loads the harness and checks every agent's model.
2. It takes a **snapshot**: the harness, every agent's settings and the full text of every skill. Editing the
   harness or a skill afterwards never changes a run that already started.
3. The run is queued, picked up by a runner and walks the graph from Start. Each step's result is stored, and a
   checkpoint is written at every step so a replacement runner can resume after a crash (per the crash policy).
4. The run ends at Finish with the **Final response**, or fails. If any agent of a Parallel step fails, the others
   are stopped and the step fails.

#### Validation rules

A harness is refused on save when:

- step ids are not unique, or a resource is not connected to any agent (_Connect `<name>` to an agent or remove it_);
- there is not exactly one Start, or no Finish (_Add a Finish node_);
- a step cannot be reached from Start, or has no path to Finish;
- a step points back to Start (_Execution cannot return to Start_);
- an agent card neither uses a saved agent nor has its own settings;
- a Parallel step has no agents, or runs something that is not an agent card of this harness;
- learning from experience is on without a knowledge workspace.

Loops are allowed (for example a Condition that sends work back), bounded by the **Step budget**.

### Worked example: the Research loop harness

The **Research loop** is the harness that runs your research. You do not build it by hand: **Research → Setup**
installs it (`POST /api/research/loop`) and rebuilds it whenever you change the models, skills, Theorists per
cycle, effort, turns or schedule there.

> Because the harness is rebuilt from the research settings, changes you make to it in the canvas are overwritten
> the next time those settings change. Change the research loop from **Research → Setup**; use the canvas to look.

**The graph** (nodes as stored):

| Node id      | Card name           | Type                                                                  | Next                         | Message it receives                                                      |
| ------------ | ------------------- | --------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `start`      | Start               | start                                                                 | `theorists`                  | —                                                                        |
| `theorists`  | Theorists           | parallel (runs `theorist_1`, `theorist_2`)                            | `judge_pre`                  | `Research cycle: {{input}}`                                              |
| `theorist_1` | Theorist 1          | agent                                                                 | — (run by the Parallel step) | `Research cycle: {{input}}`                                              |
| `theorist_2` | Theorist 2          | agent                                                                 | — (run by the Parallel step) | `Research cycle: {{input}}`                                              |
| `judge_pre`  | Judge (pre-code)    | agent                                                                 | `coder`                      | `Review the theories submitted this cycle.` + `Theorists said: {{last}}` |
| `coder`      | Coder               | agent, pattern **Autonomous loop** (4 iterations, done marker `DONE`) | `judge_post`                 | `Code and evaluate the approved theories.`                               |
| `judge_post` | Judge (post-result) | agent                                                                 | `finish`                     | `Give verdicts for the evaluated theories.`                              |
| `finish`     | Finish              | finish                                                                | —                            | returns `{{last}}`                                                       |

```
Start → Theorists (Parallel: Theorist 1 + Theorist 2) → Judge (pre-code) → Coder → Judge (post-result) → Finish
```

On the canvas the Theorists card has **Runs** links to both Theorist cards, and every agent has an **MCP tools**
card under it (`Research — Theorist`, `Research — Judge` or `Research — Coder`) with that role's tools.

**Harness-level settings:** step budget 200, _Resume when safe_, enabled, and a schedule of **Every hour** with the
message _Scheduled research cycle_ (so each Theorist receives _Research cycle: Scheduled research cycle_). When
research is paused, or when a spend cap is hit, the schedule is switched off.

**Each agent:** effort **High**, 30 turns per pass (the research setting _agent max turns_), a time limit of 1,800
seconds, and **no token budget** (0): the tools enforce per-theory caps instead, and spend caps in Research → Setup
stop all model calls when reached.

**Tools and skills per agent** (the tools are a subset of what the role's connection offers):

| Agent               | Connection          | Tools granted                                                                                                                                              | Seed skills                                               |
| ------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Theorist 1, 2       | Research — Theorist | `get_research_brief`, `search_theories`, `get_theory`, `submit_theory`, `list_collections`, `describe_collection`, `sample_collection`, `query_collection` | `strategy-library`, `read-the-catalog`                    |
| Judge (pre-code)    | Research — Judge    | `get_research_brief`, `search_theories`, `get_theory`, `review_theory`, `describe_collection`, `sample_collection`                                         | `judge-checklist`, `read-the-catalog`, `strategy-library` |
| Coder               | Research — Coder    | `get_research_brief`, `get_theory`, `submit_code`, `evaluate_strategy`, `get_evaluation`, `describe_collection`, `sample_collection`, `query_collection`   | `write-a-strategy-plugin`, `read-the-catalog`             |
| Judge (post-result) | Research — Judge    | `get_research_brief`, `get_theory`, `get_evaluation`, `set_verdict`                                                                                        | `judge-checklist`, `strategy-library`                     |

If you choose skills per role in Research → Setup, they replace the seed skills for that role. Seed skills are
found **by name**; a missing one is reported by the installer and simply not attached.

**What one cycle does:** both Theorists start at the same moment, each reads the research brief and submits one
theory (Theorist _i_ prefers the _i_-th strategy family and the _i_-th idea profile, so they differ). The Judge
reviews every theory waiting in `pre_review`. The Coder always runs; with an empty queue it replies DONE at once.
The post-result Judge gives verdicts on evaluated theories. Part 3 explains the theory lifecycle and the gates.

**How to look at it**

1. Open **Harnesses** and click **Open** on _Research loop_.
2. Double-click **Theorist 1** to see its model, instructions and skills (Knowledge tab).
3. Double-click the **Research — Theorist** tools card under it to see the granted tools.
4. Open **Settings** to see the hourly schedule and _Next run …_.
5. Close with **×** without saving.

> Running the Research loop from the Playground (**Run** on its card) starts a full cycle right away, with your
> message as the cycle input. While it runs, the hourly schedule skips its slot.

### How-to: build a small FMP quote harness

1. **Harnesses → Create harness → MCP tool assistant → Connect resources.**
2. **Harness name**: `FMP quote helper`. **Model provider**: `Gemini-flash-3-8`.
3. **MCP connection**: `FMP`; tick `quote` and `news`. Click **Open canvas**.
4. Double-click **Tool assistant**. On **General**, change **Instructions** to
   `Answer with the latest quote and the two most recent headlines for the ticker the user names.`
5. On **Reasoning**, choose **Light** effort.
6. Click **Save & test**. The Playground opens with the harness selected; type `NVDA` and press Enter.

---

## Playground

The Playground is a chat window for any harness or saved agent. You type a message, the harness runs with it as
`{{input}}`, and you watch every model turn, tool call and step result in the trace. Conversations are kept, so a
follow-up message carries the earlier messages as history.

**How to get there:** sidebar **Playground** (URL `/playground`), or **Run** on a harness card, or **Save & test**
in the editor.

### Choosing what to talk to

In the top bar, the breadcrumb's page name becomes a dropdown (_Choose a harness_). It lists every harness, then
every saved agent marked **· saved agent** (for example _M3 Coder check · saved agent_). If nothing is selected,
the first entry is picked. Your choice is remembered for the browser session.

The top bar also holds, on the right:

| Button                                                  | What it does                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Conversation export                                     | **Copy conversation**, **Download Markdown**, **Print / Save as PDF** (available when the response finishes). |
| **+** (_New conversation_)                              | Starts an empty conversation.                                                                                 |
| Terminal icon (_Show trace panel_ / _Hide trace panel_) | Toggles the right-hand panel.                                                                                 |

### The chat

An empty conversation shows the harness name, _Send a message. Every step shows up in the trace._ and two
suggestions (_What can you help me with?_, _Summarize the knowledge available to you._).

| Control                            | What it does                                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Message box (_Message <harness>…_) | Up to 32,000 characters. **Enter** sends; **Shift+Enter** adds a line.                                                                    |
| Image icon (_Attach images_)       | Up to 4 PNG, JPEG or WebP images per message, 10 MB each. You can also drop images on the chat. Images need an agent with a vision model. |
| Send arrow                         | Sends. While a run is working it becomes a stop button (_Cancel run_).                                                                    |

While the run works you see _Waiting for a runner_ (queued), _Working on your request · <step>_, or the text
streaming in. Under each answer:

| Control                    | What it does                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Thumbs up (_Good answer_)  | Records positive feedback: _Marked as helpful_.                                                                                     |
| Thumbs down (_Bad answer_) | Asks _What should the agent do differently?_; **Send** records it. With learning enabled, feedback becomes a lesson for later runs. |
| **View activity**          | Opens _Agent activity_: drafts, reviewer feedback and revisions per stage, and the raw _Execution events_.                          |
| Copy                       | **Copy message**.                                                                                                                   |

If the run pauses for a person (a Human review, a tool approval, or a question from the agent), the request appears
in the chat and in the Inbox; answer it in either place.

### The side panel

Three tabs:

**Trace.** The run id, **View activity**, the start time and status, then the event list: model turns, tool calls
with arguments and results, retrieved passages, step results. Before any run: _Model turns, tool calls, retrieved
passages and step results appear here as the run works._

**History.** This harness's conversations (title, time, `N messages`, _· running_), each with a bin
(_Delete conversation_; its runs stay in Executions), then its other recent runs from every trigger (schedule, API,
webhook), up to 30. Click a run to inspect its trace and output; **Back to the live run** returns.

**Memory.** The task notebook of the shown run: notes the run's agents wrote, shared by all its steps and
sub-agents. Search with **Search / refresh**, open a note, page through it, and **Keep in long-term memory** to
promote it to an attached knowledge base. Temporary notes expire after seven days. A _Long-term memory_ box says
whether experiment records were saved for this run.

### How-to: inspect a scheduled research cycle

1. Open **Playground** and pick **Research loop** in the top bar.
2. Open the **History** tab. Scheduled runs show _schedule_ as their trigger.
3. Click the latest one. The **Trace** tab shows each agent's tool calls, for example `Theorist 1: submit_theory`.
4. Click **View activity** to read each agent's final message.

### How-to: ask the FMP analyst

1. Pick **Financial Market Analysis** (Start → Tool assistant with the FMP tools and the `stock` skill, on
   Gemini-flash-3-8).
2. Type `Daily analysis for the known list` and press Enter.
3. In the trace you will see the agent call `load_skill` with `stock` (its description matches), then FMP tools
   such as `quote`.

---

## Skills

A skill packages instructions for one kind of task. The agent's prompt lists only each skill's name and its
_when to use it_ line; when a request matches, the agent calls the built-in `load_skill` tool and the full
instructions are added to its context for the rest of the run. This keeps long playbooks (a 42-card strategy
library, a review checklist) out of the context until they are needed.

**How to get there:** sidebar **Skills**, URL `/skills`.

### The Skills list

Title **Skills** with **Export**, **Import** and **New skill**. Each card shows an **enabled** / **disabled**
pill, a bin (_Delete <name>_), the name, the _when to use it_ line, and a footer:
_Used by N agents · M chars_ (or _Not used yet_) with **Edit**. "Used by" counts harness agent cards and saved
agents that list the skill.

### The skill editor

| Field              | What it does                                                                                           | Example                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **Name**           | Up to 64 characters. This is what `load_skill` is called with and what harnesses and YAML refer to.    | `judge-checklist`                                             |
| **When to use it** | Up to 500 characters. _The agent sees only this line until it decides the skill applies. Be specific._ | `Use whenever you review a theory or give a verdict (Judge).` |
| **Instructions**   | The full text, up to 256,000 characters (a counter shows the length). Markdown is fine.                | the checklist                                                 |
| **Skill enabled**  | A disabled skill cannot be newly ticked on an agent and is left out of new runs.                       | on                                                            |
| **Save skill**     | Saves.                                                                                                 | —                                                             |

### How skills load at run time

1. When a run starts, the server copies the full text of each enabled skill the agent lists into the run's
   snapshot. Editing a skill later never changes a running cycle; the next cycle picks up the edit.
2. The agent's system prompt gets a short block:
   `You have skills… call load_skill with its name before you start…` followed by `- <name>: <when to use it>`
   for each skill.
3. The agent calls `load_skill` with a name. The instructions are kept as protected system context in every later
   pass, with a reminder to follow the skill's required phases and output format before claiming it is done.
4. `load_skill` is offered in every pass, even passes without other tools.

**Versions.** Every save keeps the previous text as a version (`1.0.0`, `1.0.1`, …) in `skill_versions`, so earlier
versions are not lost.

### The research seed skills

The research agents' skills are kept as source in the repo (`skills/*.md`) and generated into
`deploy/config-io/seed/skills.yaml` for a fresh install:

| Skill                     | For                                                                                                                                                             | Loaded by                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `strategy-library`        | 42 strategy cards (S01–S42) by family: the signal, the real collections and fields, default parameters, point-in-time traps, whether it can be backtested today | Theorists, both Judges             |
| `write-a-strategy-plugin` | The plugin contract (`META`, `signal(ctx)`, `ctx.read_df`), worked examples and the submit / test / fix / evaluate loop                                         | Coder                              |
| `read-the-catalog`        | The research data tools, what as_of means per collection, the caveats that change results                                                                       | Theorists, Judge (pre-code), Coder |
| `judge-checklist`         | Pre-code review (testable, no lookahead, novel, plausible) and post-result review (overfitting, factor in disguise, caveats)                                    | both Judges                        |

The Research loop finds these **by name** when it is installed or rebuilt. Each agent's instructions also say which
skill to follow (for example _Follow the judge-checklist skill_), so the agent loads it at the start of its turn.

`deploy/config-io/exports/skills.yaml` is the automatic backup of what is live in the workspace. It currently also
holds the `stock` skill (the daily trader brief used by _Financial Market Analysis_).

> In this deployment all four research skills are live under their exact names: `strategy-library`,
> `read-the-catalog` and `judge-checklist`, and `write-a-strategy-plugin` (plus the general `stock` skill). The
> Theorist loads strategy-library and read-the-catalog, the Judge loads judge-checklist, and the Coder loads
> write-a-strategy-plugin and read-the-catalog. The repo backup `deploy/config-io/exports/skills.yaml` is out of
> date (it lists only `stock` and `strategy-library`); a refresh is ticketed. A skill missing under its exact name
> is silently left off the research agents, so keep the names unchanged.

### How-to: install or update a seed skill

1. Open **Skills → Import**.
2. Choose `deploy/config-io/seed/skills.yaml` as **YAML file**, keep **Mode: Merge**.
3. Click **Preview**. Check the _Create_ and _Update_ lists.
4. Click **Apply import**.
5. The next research cycle snapshots the new text. (If the skill was missing when the loop was installed, change
   any research setting or re-save Setup so the harness is rebuilt and attaches it.)

### How-to: write your own skill

1. **Skills → New skill**.
2. **Name**: `earnings-drift-checks`.
3. **When to use it**: `Use when a theory trades around earnings announcements.`
4. **Instructions**: the steps and checks, for example which calendar collection gives the announcement date and
   the rule to trade only from the next session.
5. **Save skill**. Then tick it on an agent (agent settings → **Knowledge** → **Skills**), or choose it for a role in
   Research → Setup.

---

## MCP connections

An MCP connection is how agents reach tools: a saved server address with its credentials and the list of tools
discovered on it. Agents only get tools that a connection has discovered, and only the ones you tick.

**How to get there:** sidebar **MCP connections**, URL `/connections`.

### The connections list

Title **MCP connections** with **Connect a server**. Each row shows:

| Part                            | Meaning                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| Name                            | Click to edit.                                                                                   |
| Auth pill                       | **No auth**, **API key**, **OAuth connected** or **Authorization needed**.                       |
| `N tools`                       | Discovered tools.                                                                                |
| **disabled**                    | When the connection is switched off.                                                             |
| URL and transport               | **Streamable HTTP** or **Legacy SSE**; _Discovered <time>_. Built-in connections have no URL.    |
| Tool chips                      | The first 8 tools (_+N more_ expands). Click a chip to see its description and **Input schema**. |
| **Authorize** / **Reauthorize** | OAuth connections only: opens the provider's sign-in in a pop-up.                                |
| **Discover tools**              | Asks the server for its current tools and saves them.                                            |
| Gear / bin                      | Edit / delete (with confirmation).                                                               |

Machine connections (from the Machines page) are not listed here.

In this deployment you will see, among others, **FMP** (the market-data tools used by _Financial Market Analysis_:
`quote`, `statements`, `news`, `technicalIndicators`, `insiderTrades`, `secFilings`…), **Research data** (used by
the saved agent _M3 Coder check_), and the three role connections **Research — Theorist**, **Research — Judge**,
**Research — Coder**.

### The connection form

**Connect a server** opens _Connect an MCP server_ (or _Edit MCP connection_).

| Field                                                                           | What it does                                                                                                                                              | Example                           |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Server type**                                                                 | **MCP server** (any remote server), **MongoDB (MongoDB MCP server)**, **StockHarness research data (built in)**.                                          | MCP server                        |
| **Connection name**                                                             | How agents and YAML refer to it.                                                                                                                          | `FMP`                             |
| **Server URL**                                                                  | MCP server and external MongoDB only. HTTP(S), no credentials in the URL.                                                                                 | `https://your-server.example/mcp` |
| **Transport**                                                                   | **Streamable HTTP** (current standard) or **Legacy SSE**.                                                                                                 | Streamable HTTP                   |
| **Authentication**                                                              | **No authentication**, **Access token / API key**, **OAuth 2.0 (sign in with the provider)**.                                                             | Access token / API key            |
| **Token header**                                                                | For a token: `Authorization` sends `Bearer <token>`; other headers (`X-API-Key`, `api-key`) send the raw value.                                           | `Authorization`                   |
| **Access token**                                                                | Stored encrypted, never sent back to the browser. Leave untouched to keep a saved one.                                                                    | (hidden)                          |
| **Callback URL**                                                                | For OAuth: the URL to give the provider, `<public URL>/api/mcp/oauth/callback`, with a copy button.                                                       | —                                 |
| **Client ID (optional)** / **Client secret (optional)** / **Scopes (optional)** | For OAuth providers that need them.                                                                                                                       | —                                 |
| **MongoDB**                                                                     | MongoDB only: **This installation's MongoDB** or **Another MongoDB MCP server**.                                                                          | This installation's MongoDB       |
| **Database**                                                                    | External MongoDB only: every tool call uses this database.                                                                                                | `analytics`                       |
| **As of (optional)**                                                            | Research data only: fix the session date for every read. Empty: the latest trading date, capped before the holdout.                                       | empty                             |
| **Research role**                                                               | Research data only: **Data tools only**, **Theorist: submit theories**, **Judge: review theories and set verdicts**, **Coder: submit code and evaluate**. | Theorist                          |
| **Connection enabled**                                                          | A disabled connection's tools are unavailable.                                                                                                            | on                                |

The save button reads **Save and discover tools** (new connection), **Save, then authorize** (new OAuth connection)
or **Save connection** (editing). Changing the URL, authentication type, OAuth client or scopes clears the
discovered tools and the OAuth tokens, so discover (or authorize) again.

**How to add a token-protected MCP server**

1. **MCP connections → Connect a server**. **Server type**: MCP server.
2. **Connection name**, **Server URL**, **Transport**: Streamable HTTP.
3. **Authentication**: Access token / API key; set **Token header** and **Access token**.
4. Click **Save and discover tools**. The row shows the tool count.
5. Attach it to an agent: in a harness, drag the connection from the toolbox's **MCP tools** onto the agent and tick
   the tools.

> In this deployment the **FMP** connection is an MCP connection whose API key is part of its URL (`…/mcp?apikey=…`).
> The URL field is stored and shown in plain text, unlike the encrypted token field, so anyone who can open MCP
> connections can read the key. Prefer the token field if the server accepts the key as a header, and rotate a key
> that has been exposed. (Connections are never exported to YAML, so the key is not in backups.)

### The built-in MongoDB connection

With **Server type: MongoDB** and **This installation's MongoDB**, the stack's own MongoDB MCP server is used. You
give no URL or password; the workspace gets its own database (`oh_ws_…`), and the application database is never
reachable. StockHarness removes `database` and `connectionId` from every tool's inputs and sets them itself, so an
agent cannot point a call at another database. Its collections appear under **Knowledge → Collections**. Agents get
tools such as `find`, `aggregate`, `count`, `insert-many`, `update-many`, `delete-many`, `create-index`,
`collection-schema`. Limit an agent with collection bindings (see [Node types](#node-types)).

The built-in option appears only when the installation has `MONGODB_MCP_URL` and `MONGODB_MCP_TOKEN` set.

> In this deployment the built-in MongoDB connection is named **MongoDB** (served by the `mongodb-mcp` service).

### The research data connection and its role-scoped tools

**StockHarness research data (built in)** is served by the API itself at `/mcp/research` (Streamable HTTP, POST
only, stateless). You give no URL or credentials. When an agent uses the connection, the runtime calls the API's
internal address (`EXECUTOR_CALLBACK_URL` + `/mcp/research`) with a bearer token of the form
`ohrs.<connectionId>.<signature>`. The signature proves which connection and workspace is calling, so the **role**
and the **as-of date** always come from the saved connection, never from the agent.

Every data read is cut at the session as-of date: the connection's **As of**, else the latest price date, and never
on or after the start of the locked holdout. `query_collection` may ask for an earlier date, never a later one, and
returns at most 500 rows.

What each role is offered by the server:

| Tool                  | No role | Theorist | Judge | Coder | What it does                                                                         |
| --------------------- | :-----: | :------: | :---: | :---: | ------------------------------------------------------------------------------------ |
| `list_collections`    |    ✓    |    ✓     |   ✓   |   ✓   | Readable collections with layer, size, point-in-time status                          |
| `describe_collection` |    ✓    |    ✓     |   ✓   |   ✓   | The catalog entry: grain, key, known-at rule, coverage, caveats, every field         |
| `sample_collection`   |    ✓    |    ✓     |   ✓   |   ✓   | The latest few rows (up to 20) known by the as-of date                               |
| `query_collection`    |    ✓    |    ✓     |   ✓   |   ✓   | Filtered rows (MongoDB filter, fields, sort, limit ≤ 500, optional earlier `as_of`)  |
| `get_research_brief`  |    ✓    |    ✓     |   ✓   |   ✓   | Focus, steering notes, recent theories, the caller's queue, evaluation window, gates |
| `search_theories`     |    ✓    |    ✓     |   ✓   |   ✓   | Closest theories, any status                                                         |
| `get_theory`          |    ✓    |    ✓     |   ✓   |   ✓   | A theory with status, plugin versions, evaluations, debate                           |
| `get_evaluation`      |    ✓    |    ✓     |   ✓   |   ✓   | An evaluation's results                                                              |
| `test_strategy`       |    ✓    |          |       |   ✓   | Dry-run plugin code                                                                  |
| `evaluate_strategy`   |    ✓    |          |       |   ✓   | Run the trusted evaluator (each run is a trial)                                      |
| `submit_theory`       |         |    ✓     |       |       | New or revised theory                                                                |
| `review_theory`       |         |          |   ✓   |       | Pre-code review: approve, revise, reject                                             |
| `set_verdict`         |         |          |   ✓   |       | Post-result verdict: successful, failed, revise                                      |
| `submit_code`         |         |          |       |   ✓   | Save the next plugin version and test it                                             |

Note that **Data tools only** (no role) still offers the read-only research tools and `test_strategy` /
`evaluate_strategy`, but none of the tools that change a theory. Calling a tool outside the role returns an error
such as _submit_theory is for the theorist; this connection acts as judge_. The runtime also tells the research
server which agent, run and model is calling, and that is recorded in each theory's debate.

The Research loop creates the three role connections by name if they are missing, and refuses to install if a
connection with one of those names exists with another type or role. It re-discovers their tools on every install,
which also picks up new tools after an upgrade.

### How-to: give a test agent read-only research data

1. **MCP connections → Connect a server**. **Server type**: StockHarness research data (built in).
2. **Connection name**: `Research data (2025-06-30)`. **As of (optional)**: `2025-06-30`. **Research role**:
   Data tools only.
3. **Save and discover tools**.
4. In a harness, attach it to an agent and tick only `list_collections`, `describe_collection`,
   `sample_collection`, `query_collection`. Every read that agent makes is cut at 30 June 2025.

---

## Knowledge

Knowledge holds what agents can look things up in. It has two views, switched by the tabs in the top bar:

- **Documents**: knowledge bases of notes and files, indexed in a vector store and searched by meaning.
- **Collections**: MongoDB collections of JSON records, browsed and edited through the MongoDB MCP connection,
  the same way agents use them.

**How to get there:** sidebar **Knowledge**. Documents at `/knowledge`, Collections at `/knowledge/collections`.
Clicking the sidebar item always opens Documents.

### Documents

With no knowledge base yet: _No knowledge bases yet_ and **New knowledge base**. Otherwise three columns.

**Left: Knowledge bases.** One card per base with its description, `N files · <embedding model>`, a gear
(_Settings for <name>_) and a bin (_Delete <name>_, which deletes the base and all of its files). The panel can be
hidden (_Hide knowledge bases_) and shown again.

**Middle: the files of the selected base.** The header shows the name and `N files · K indexing ·
<embedding model>` (or _embedding provider missing_), with:

| Control      | What it does                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **New note** | Opens an empty Markdown note in the editor.                                                                                                                                                      |
| **Upload**   | Upload `.txt`, `.md`, `.csv`, `.json`, `.yaml`, `.yml`, `.pdf` or `.docx` files (several at once). You can also drop files anywhere on the panel. Size limit: `MAX_UPLOAD_MB`, 20 MB by default. |
| **Ask**      | Opens _Ask <base>_: type a question and **Search** to see the passages an agent would get. Enabled once a file is ready.                                                                         |
| _Filter…_    | Filters files by name.                                                                                                                                                                           |

Each file shows a pen (note) or page (upload) icon, its folder when it has one (for example `research/`,
`experiments/`), `N passages` when ready, _Indexing failed_, or its status (`queued`, `indexing`), and the time. The
list refreshes every 3 seconds.

**Right: the editor.**

- A **note** opens for editing: a title (_Untitled note_), the text area (_Write in Markdown. Saving re-indexes the
  note so agents can find it._), a word count, **Save** (or ⌘S / Ctrl+S; it reads **Saved** when nothing changed),
  **Reindex** and _Delete note_.
- A `.txt`, `.md`, `.csv`, `.json` or `.yaml` upload shows its text (up to 20,000 characters). PDF and Word files
  show _Preview is not available for this file type. Download to view._ Every file has **Download**, **Reindex**
  and _Delete document_, plus its size, passages and date.

**What happens underneath.** Uploads and notes are queued, split into passages, embedded with the base's embedding
model and stored in its vector store. A file is usable by agents when its status is **ready**. Agents use a base
in two ways:

- **Reference knowledge** (a Knowledge card attached to an agent): the agent can search and read it, read only.
- **Long-term memory** (the harness's _Knowledge workspace_, or an agent's _Long-term memory_): agents also write
  to it with `kb_write`. Each write is a new note (nothing is overwritten) in a folder by kind: findings in
  `research/`, decisions in `decisions/`, feedback in `feedback/`, other notes in `notes/`. Completed runs save an
  experiment record in `experiments/`, and lessons go in `experience/` when learning is on. Recent notes are
  searchable at once, even before indexing finishes.

#### Creating a knowledge base

**New knowledge base** (top bar) opens _Create a knowledge base_:

| Field                                      | What it does                                                                                                                                     | Example                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| **Name**                                   | The base's name.                                                                                                                                 | `Research notes`                           |
| **Description**                            | What is in it.                                                                                                                                   | `Write-ups of evaluated ideas and caveats` |
| **Embedding provider**                     | The model that turns text into vectors. Only providers with an embedding model are listed. _Fixed for the life of the knowledge base._           | `Gemini embeddings · gemini-embedding-001` |
| **Vector store**                           | Shown only when the installation offers more than one: Weaviate, Qdrant, OpenSearch, Elasticsearch, OpenAI-compatible Vector Stores. Also fixed. | Weaviate                                   |
| **Add a provider with an embedding model** | Opens the provider form if you have none.                                                                                                        | —                                          |
| **Save knowledge base**                    | Creates it.                                                                                                                                      | —                                          |

> This deployment has **no embedding provider and no knowledge base** yet. To use Knowledge documents with search,
> first add an embedding provider (for example `gemini-embedding-001` with the _Google Gemini on Vertex AI_ preset;
> test it before relying on it).

**How to keep research write-ups as a knowledge base**

1. Top bar **New knowledge base**. **Name** `Research notes`, pick the embedding provider, **Save knowledge base**.
2. **New note**, title `Momentum caveats`, write the text, **Save**. The file shows _indexing_, then `N passages`.
3. Click **Ask**, type `what are the momentum caveats?`, **Search**. The note's passages appear.
4. To let an agent use it, attach a Knowledge card to the agent in its harness. To let it write there too, tick
   **Use as harness long-term memory** on that card, or choose it as the harness's **Knowledge workspace**.

#### Model providers for this deployment

The provider form (from **Add model provider** anywhere) has presets. For this deployment use **Google Gemini on
Vertex AI** with a Vertex AI express-mode key (it starts with `AQ.`):

| Provider name      | Model ID           | API base URL                                                                                 |
| ------------------ | ------------------ | -------------------------------------------------------------------------------------------- |
| `Gemini-flash-3-8` | `gemini-3.8-flash` | `https://aiplatform.googleapis.com/v1/publishers/google`                                     |
| `Gemini-4-pro`     | `gemini-4-argon`   | `https://aiplatform.googleapis.com/v1/projects/<project>/locations/global/publishers/google` |

`gemini-4-argon` is a preview model served only in the **global** location, so it needs the project-scoped global
base URL. With the wrong URL the provider error says so: _The model … is not served in … Preview models are often
only in the global location…_. The form also has **Model type** (LLM, Vision, Embedding), **Maximum output tokens**,
**Context window (tokens)** and **Output budget field**; Settings (Part 4) covers it fully.

### Collections

The Collections tab works with MongoDB collections through a MongoDB MCP connection. Every action is a tool call
on that connection, so you see exactly what agents see.

With no MongoDB connection: _Connect MongoDB_ explains the tab, and the **Connect MongoDB** button opens the
connection form preset to Server type MongoDB with the name `MongoDB`.

**Left: Collections.** The connection's name (a dropdown when there are several), **Connection settings**,
**Reload collections**, and _Workspace database_ (built-in) or _Database <name>_ (external). Type a name in
_New collection…_ and click **+** (_Create collection_): letters, digits, `_`, `-` or `.`. Each collection card
shows its document count and a bin (_Delete <name>_), which drops the collection and all its documents after
confirmation.

**Middle: documents.** The collection name and `N documents` (_match the filter_ when filtered), with:

| Control         | What it does                                                                 | Example                |
| --------------- | ---------------------------------------------------------------------------- | ---------------------- |
| **Insert JSON** | Opens the insert pane.                                                       | —                      |
| **Indexes**     | Opens the index pane.                                                        | —                      |
| **Filter**      | A MongoDB filter.                                                            | `{ "symbol": "AAPL" }` |
| **Sort**        | A MongoDB sort.                                                              | `{ "date": -1 }`       |
| **Apply**       | Runs the query. Results come 25 at a time, with previous / next page arrows. | —                      |

Each document shows its `_id` and its first three fields.

**Right: the detail pane.**

- **Document**: the JSON. The pencil (_Edit document_) opens it for editing; **Save** replaces the whole document
  (_fields you remove are deleted. The \_id stays._); **Cancel**; _Delete document_.
- **Insert into <collection>**: paste one object or an array, or **Load .json file**, then **Insert**. Values that
  are not objects are stored as `{ "value": … }`. Extended JSON such as `{ "$date": "2026-01-01T00:00:00Z" }` is
  understood.
- **Indexes on <collection>**: _Field, e.g. customer.email_, type **Ascending**, **Descending** or **Text search**,
  **Add index**. The list shows each index with arrows for direction; the bin removes it (not `_id_`). A text
  index lets agents search words with `{ "$text": { "$search": "…" } }`; a collection has at most one.

**How to look up one stock's recent rows**

1. **Knowledge → Collections**. Select `prices_daily` in the left list.
2. **Filter**: `{ "symbol": "NVDA" }`. **Sort**: `{ "date": -1 }`. Click **Apply**.
3. Click the first document to read the latest row.

> The built-in MongoDB connection points at the workspace database (`oh_ws_…`), the same one the syncs and
> transforms write to, so `prices_daily`, `universe_daily` and the other synced collections appear in this list.

Be careful here: edits and deletes on this tab change the real data that transforms, the research tools and the
evaluator read. Use the Datasets pages (Part 2) to manage synced data; use this tab to look, or for your own
collections.

---

---

# Part 2: Data (Layers 1 and 2)

This part covers everything about data in StockHarness: where it comes from, how it is stored, how it is
cleaned, and how you check it is complete and on time. It is all on one page, **Datasets**, with five tabs.

| Tab            | Layer   | What it is for                                                                           |
| -------------- | ------- | ---------------------------------------------------------------------------------------- |
| **Syncs**      | 1       | Pull raw data from FMP into MongoDB collections, on a schedule                           |
| **Transforms** | 2       | Python code that turns raw collections into clean, point-in-time collections             |
| **Pipelines**  | 1 to 5  | Run syncs, transforms and later layers as one dependency graph per period, with gates    |
| **Catalog**    | 1 and 2 | What every collection holds: fields, time rules, coverage, caveats, sample rows, lineage |
| **Health**     | 1 and 2 | Is the data fresh and complete? What is late, failing or drifting?                       |

## Key terms

These terms come up everywhere in this part.

- **Collection.** A MongoDB table. Each workspace has its own database, and every dataset, transform output and
  log lives there as a collection (`eod_prices`, `prices_daily`, `dq_issues` …).
- **Layer 1 (raw data).** Collections written by a **dataset sync**: data copied from FMP as it comes, with only
  the sync's own bookkeeping added (`symbol`, `_syncedAt`, and `snapshot_date` for weekly snapshots). Layer 1 is
  usable on its own; agents and strategies can read it directly.
- **Layer 2 (prepared data).** Collections written by a **transform**: Python code that reads Layer 1 (or other
  transforms' outputs) and writes flat, deduplicated, point-in-time tables such as `prices_daily` (split- and
  dividend-adjusted prices) or `universe_daily` (the tradeable universe on each date). Layer 2 is optional: you add
  a transform only where raw data needs cleaning, joining or point-in-time fixes.
- **Known-at and point in time (PIT).** Every row has a moment when it became public: a price at the 16:00 ET
  close, a 10-Q at its SEC acceptance time, a dividend at its declaration. That moment is its **known_at**. The
  first trading date on which you may act on it is its **as_of_date**. A **point-in-time read** for date D returns
  only rows with `as_of_date <= D`, so a backtest never sees information from its future (no lookahead).
- **Sync universe.** The list of symbols that per-symbol syncs iterate over: active US stocks from the FMP
  screener plus delisted companies, so history of companies that later died is pulled too (survivorship-free).
  It is the `universe` collection. It is _not_ the research universe; that is `universe_daily` (Layer 2).
- **Cursor.** For time-series datasets (prices), the date the sync last succeeded. The next run pulls from the
  cursor to today, so a daily run fetches only the new days.
- **Backfill.** Pulling a long stretch of history in resumable batches, separately from the normal incremental
  run, at the lowest priority so scheduled syncs always go first. Syncs, transforms and pipelines each have
  their own backfill.

### How data flows in this deployment

FMP (stable API, `https://financialmodelingprep.com/stable`) is the only data provider. About 40 dataset syncs
(`L1 — …`) pull into Layer 1. Nine transforms build Layer 2 and chain themselves with "run after" triggers:

```
FMP ──► Layer 1 syncs                      ──► Layer 2 transforms
        eod_prices (daily, from 2016) ────┐
        dividends_calendar, splits_calendar ──► corporate_actions ──► prices_daily ──► universe_daily
        company_profiles (weekly) ─────────► securities              │                   │
        income_statement, balance_sheet,                              │                   ▼
        cash_flow (weekly, 40 quarters) ───► fundamentals_pit ────────┴──────────► features_daily ──► features_ranked
        treasury_rates, eod_index ─────────► macro_daily
        (no input) ────────────────────────► trading_calendar (every 30 days)
```

The research scope is the **S&P 500 proxy**: the plan has no index membership, so a strategy asks for
`universe.top_by_market_cap: 500` and the engine takes, on each rebalance date, the 500 largest members of
`universe_daily` by its `market_cap` field for that date (delisted names included while they were listed).

---

## Datasets

**Sidebar:** **Datasets** (database icon). **URL:** `/datasets/<tab>[/<item>]`. Every screen has its own link:

| URL                                                                            | Screen                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `/datasets` or `/datasets/syncs`                                               | Syncs list (the bare `/datasets` is rewritten to `/datasets/syncs`) |
| `/datasets/syncs/<sync id>`                                                    | One sync's detail page                                              |
| `/datasets/transforms`                                                         | Transforms list                                                     |
| `/datasets/transforms/<name>`                                                  | Transform editor, e.g. `/datasets/transforms/prices_daily`          |
| `/datasets/transforms/new`                                                     | A new transform (from a template)                                   |
| `/datasets/pipelines`, `/datasets/pipelines/<name>`, `/datasets/pipelines/new` | Pipelines                                                           |
| `/datasets/catalog`, `/datasets/catalog/<collection>`                          | Catalog, e.g. `/datasets/catalog/universe_daily`                    |
| `/datasets/catalog/_graph`                                                     | The full lineage graph                                              |
| `/datasets/health`                                                             | Health                                                              |

An unknown tab falls back to Syncs. The page title reads **Data / Datasets**: "Layer 1 syncs pull raw data;
optional Layer 2 transforms (Python) turn it into flat point-in-time collections. Everything is exportable as
YAML."

**Who can change what.** Everyone in the workspace can browse every tab. Only **administrators** see the
buttons that change things: add, edit, run, delete, bulk actions, import, editing catalog docs, resolving drift.
The API refuses changes from other roles ("Only administrators can change dataset syncs").

The data-freshness pill in the top bar (for example "Data fresh as of 2026-11-07 close", or "2 syncs late")
opens **Datasets → Health**. See [Health](#health-tab).

### Syncs tab

**What it is for.** Layer 1: "raw market data synced from FMP into MongoDB collections, browsable here and
reusable by transforms and agents." Each row is one **dataset sync**: one FMP dataset, which symbols, how much
history, which collection, and when it runs.

**How to get there.** Datasets → **Syncs** (`/datasets/syncs`).

When there are no syncs yet you see "No datasets yet" with **Add dataset sync** and **Import YAML**.

#### KPI cards

| Card                | Value                                                                  | Footnote                                               |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| **Syncs**           | Number of syncs                                                        | "N enabled"                                            |
| **Collections**     | Distinct target collections                                            | Total rows in them (from the Catalog)                  |
| **Healthy**         | Enabled syncs whose last run did not fail                              | "N need attention" (the rest, including disabled ones) |
| **FMP calls today** | FMP requests made by sync runs since local midnight (retries included) | "N runs, N failed"                                     |

Backfill calls are counted on the backfill, not here.

#### The filter bar

One row: a search box (**Search syncs**, matches the sync name and dataset id), a **Filters** button, the active
filters as chips, and "N of M" when filters hide rows.

**Filters** opens a small popover with one select per filter. Pick values, then **Done**. **Clear all** removes
every filter. Each active filter also shows as a chip such as "Status: failed ×"; click the chip to remove that
filter. Escape or a click outside closes the popover.

| Filter       | Options                                                                                  | What it matches                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Category** | All categories, Calendars, Estimates, Fundamentals, Market, Ownership, Prices, Reference | The dataset's category                                                                                                           |
| **Priority** | All priorities, P0, P1, P2                                                               | The sync's effective priority (its own, else the dataset default)                                                                |
| **Status**   | All statuses, ready, running, queued, failed, disabled                                   | See the Status column below                                                                                                      |
| **Cadence**  | Any cadence, intraday, daily, weekly, monthly, manual                                    | From the schedule: under a day = intraday, exactly a day = daily, up to a week = weekly, longer = monthly, schedule off = manual |

The same filter bar (search, **Filters**, chips) is used on other list pages of the studio.

#### The toolbar (administrators)

| Control                              | What it does                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Select all** / "N of M selected"   | Ticks every sync (the header checkbox does the same)                                                                                                                                 |
| **Export all** / **Export selected** | Downloads `dataset-syncs-YYYY-MM-DD.yaml` with the configuration of every sync, or only the ticked ones                                                                              |
| **Import YAML**                      | Opens the import dialog (below)                                                                                                                                                      |
| **Run**                              | Queues a run of every ticked sync, by priority. Notice: "Queued N syncs by priority (they share the FMP rate limit) (N already running)."                                            |
| **Enable** / **Disable**             | Turns the ticked syncs on or off. Enabling re-seeds the schedule from now, so missed slots do not all fire at once                                                                   |
| **Reset cursor**                     | "Forget the sync cursor so the next run re-pulls history from the start date." Data is kept                                                                                          |
| **Backfill**                         | After a confirm, starts a history backfill for each ticked sync (10 years by default, or from the sync's **From** date). Syncs that cannot be backfilled are skipped with the reason |
| **Purge records**                    | After a confirm dialog, deletes every document in the ticked syncs' collections. The syncs stay; their cursors (and those of any other sync writing the same collection) are reset   |
| **Delete**                           | After a confirm dialog, deletes the ticked sync configurations. Tick "Also drop these collections (skipped for any collection another sync still writes to)" to drop the data too    |
| **×** (Clear selection)              | Unticks everything                                                                                                                                                                   |

A notice under the toolbar reports what happened, for example "Backfill queued for 3 syncs; skipped 1 (Latest-items
feed: FMP serves no history for it.). History is pulled in resumable batches at the lowest priority."

#### The table

Click a row to open that sync's [detail page](#sync-detail-page).

| Column       | What it shows                                                                                                                                                                            | Example                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Name**     | The sync's name                                                                                                                                                                          | `EOD prices (5y, universe)`                            |
| **Dataset**  | The catalog label of the FMP dataset                                                                                                                                                     | `EOD prices (OHLCV)`                                   |
| **Symbols**  | `Market` (not per symbol), `Universe`, the preset name, or "N tickers"                                                                                                                   | `Universe`, `Mega-cap (> $200B)`                       |
| **Priority** | P0, P1 or P2; "auto" means the dataset default (hover for which)                                                                                                                         | `P0 auto`                                              |
| **History**  | "N periods" (row depth), "from YYYY-MM-DD", the dataset's default periods, or "incremental"                                                                                              | `from 2016-01-01`, `40 periods`                        |
| **Coverage** | For per-symbol datasets: a bar with the share of the sync universe that has rows. Otherwise the row count                                                                                | `97.8%`                                                |
| **Schedule** | The schedule in words                                                                                                                                                                    | `Every day at 18:49`, `Every Saturday at 02:00`, `Off` |
| **Next run** | Next scheduled run (only when the schedule is on)                                                                                                                                        |                                                        |
| **Last run** | When it last ran                                                                                                                                                                         |                                                        |
| **Rows**     | Rows written (inserted or changed) by the last run, not the collection size                                                                                                              | `2,184`                                                |
| **Status**   | `running`, `queued`, `failed` (enabled and the last run failed), `ready`, `disabled`; plus a **backfill** badge ("backfill 42%", "backfill paused") while a backfill is active or failed |                                                        |
| (actions)    | **Run now**, **Edit**, **Delete** ("The collection is kept.")                                                                                                                            |                                                        |

While any sync is running, the page refreshes itself every 5 seconds.

#### Add or edit a dataset sync

**Add dataset sync** (top right) or the pencil on a row opens the form **Add dataset sync** / **Edit dataset
sync**. Fields appear only when they apply to the chosen dataset.

| Field                                                               | What it does                                                                                                                                                                                                                                                        | Example                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Name**                                                            | Unique name; YAML import matches syncs by it                                                                                                                                                                                                                        | `L1 — Treasury rates`           |
| **Source connection**                                               | The FMP MCP connection whose `apikey` URL parameter is used. Defaults to the connection named like FMP                                                                                                                                                              | `FMP`                           |
| **Dataset**                                                         | The FMP dataset, shown as "category · label". Picking one also sets the schedule interval to the dataset's recommended cadence. Its description shows below                                                                                                         | `Market · Treasury rates`       |
| **Symbols** (per-symbol datasets)                                   | **Reuse the Universe collection**, **Screener preset** or **Explicit ticker list**                                                                                                                                                                                  | Universe                        |
| **Preset**                                                          | One of the screener presets (table below)                                                                                                                                                                                                                           | `Top 500 US (S&P 500-like)`     |
| **Tickers**                                                         | "Comma or space separated, e.g. AAPL, MSFT, NVDA" (at most 5,000)                                                                                                                                                                                                   | `AAPL, MSFT`                    |
| **From** / **To** (datasets with a date range)                      | "First pull starts here (e.g. 5 years ago)." / "Leave blank for today."                                                                                                                                                                                             | `2016-01-01`                    |
| **History depth (quarters per symbol)** or **(periods per symbol)** | Rows per symbol for limit-based datasets (statements, metrics, estimates), 1 to 200. Hint: "Default 8. Target for statements: 40 quarters."                                                                                                                         | `40`                            |
| **Statement period**                                                | **Default (quarter)** / **Quarterly** / **Annual**, for datasets with a period parameter                                                                                                                                                                            | Quarterly                       |
| **Test depth**                                                      | "Asks FMP for as much history as possible for one symbol (AAPL), to check what the plan allows." Shows "FMP returned <rows> rows for AAPL: <earliest> → <latest> (<years> years)." It steps the request down (200, 100, 40, 20, 10 rows) until the plan accepts one |                                 |
| **Collection**                                                      | Target collection; blank uses the default shown in the hint. Letters, digits and underscores                                                                                                                                                                        | blank (`treasury_rates`)        |
| **Priority**                                                        | **Auto (dataset default)**, **P0: prices, corporate actions, calendars**, **P1: fundamentals, estimates, ownership**, **P2: news, segments, peers, movers**. "Which syncs get FMP capacity first when the rate limit is reached."                                   | Auto                            |
| **Retention (days)**                                                | "Optional: prune rows older than this." Applied after each run on the dataset's date field                                                                                                                                                                          | blank ("Keep everything")       |
| **History backfill** (edit only)                                    | The [backfill panel](#backfills)                                                                                                                                                                                                                                    |                                 |
| "Schema, coverage and caveats of … in the Catalog" (edit only)      | Link to the collection's Catalog page                                                                                                                                                                                                                               |                                 |
| **Schedule**                                                        | Off / Interval / Daily / Weekly / Event (below)                                                                                                                                                                                                                     | Daily at 18:30 America/New_York |
| **Sync enabled**                                                    | Unticked, the sync never runs on a schedule or trigger                                                                                                                                                                                                              | ticked                          |

**Create** (or **Save**) stores the sync. Saving an edit keeps the cursor and re-seeds the schedule, so the next
run follows the new schedule. A new daily or weekly sync waits for its first slot; it does not run on save; an interval sync starts within a minute.

**Screener presets** (for the **Screener preset** symbol mode; resolved with the FMP screener at each run,
sorted by market cap, ETFs and funds excluded):

| Preset                               | Rule                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| **Mega-cap (> $200B)**               | NASDAQ, NYSE, AMEX above $200B                                                     |
| **Large-cap (> $10B)**               | Above $10B                                                                         |
| **Top 500 US (S&P 500-like)**        | The 500 largest above $1B ("proxy; exact S&P 500 membership needs a plan upgrade") |
| **Top 100 Nasdaq (Nasdaq-100-like)** | The 100 largest Nasdaq names above $1B                                             |
| **All NYSE** / **All Nasdaq**        | Actively trading names above $50M                                                  |

A preset is today's list, so a preset sync is not survivorship-free. Research uses the universe and
`universe_daily` instead.

#### The Schedule section

The **Schedule** field has five modes:

| Mode         | Fields                                                                                        | What happens                                                             |
| ------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Off**      | none                                                                                          | "Runs only when started: Run now, a bulk run, a backfill or a pipeline." |
| **Interval** | **Every**, **Unit** (minutes / hours)                                                         | Runs every N minutes or hours                                            |
| **Daily**    | **At**, **Time zone**                                                                         | Once a day at that wall-clock time. Default 18:30                        |
| **Weekly**   | **On** (weekday), **At**, **Time zone**                                                       | Once a week. Default Saturday 06:00                                      |
| **Event**    | **After these complete**, **After each company's earnings report**, **Days after the report** | No clock; runs when upstream work finishes (below)                       |

For every mode except Off and Event, a preview lists the next five run times, computed exactly as the
scheduler does. The **Time zone** list offers your browser's zone, `America/New_York` and `UTC`; this deployment
uses `America/New_York` for its syncs.

A **cadence** warning appears when an end-of-day dataset runs more than once a day, for example "EOD prices
(OHLCV) updates once a day; running it every 2 hours spends FMP calls for no new data." Feeds that legitimately
change during the day (news, quotes, price targets, grades, movers, insider and congress trades) do not warn.

**Event mode** has two triggers (they can be combined):

- **After these complete**: a checklist of other syncs' collections (`sync → eod_prices`) and transforms
  (`transform corporate_actions`). "The sync runs once all of them have completed since its last run." It waits
  60 seconds after the last upstream event, so a burst of completions starts one run.
- **After each company's earnings report** with **Days after the report** (0 to 60, default 2): "Pulls just the
  companies that reported that many days ago (earnings_calendar)." Once a day, the scheduler reads the earnings
  calendar for the date N days ago, keeps the symbols inside this sync's own scope (its universe, list or
  preset), and runs the sync for only those symbols. Such a partial run never moves the cursor. It needs an
  earnings-calendar sync; saving without one fails with "After earnings needs an earnings calendar sync (dataset
  earnings_calendar)".

Saving refuses a sync that runs after itself, or after a collection no other sync writes.

#### Import and export YAML

**Export** writes the configuration of syncs, never data and never secrets. The connection is written by name:

```yaml
# StockHarness dataset sync configuration. Import it from Datasets -> Import YAML.
# The connection is matched by name on import; secrets and synced data are not included.
apiVersion: stockharness/v1
kind: DatasetSyncs
exportedAt: 2026-11-10T09:00:00.000Z
syncs:
  - name: EOD prices (5y, universe)
    dataset: eod_prices
    connection: FMP
    enabled: true
    symbolsMode: universe
    from: 2016-01-01
    schedule:
      enabled: true
      everyMinutes: 1440
      input: daily eod
      at: '18:49'
      timezone: America/New_York
```

**Import YAML** opens "Import dataset syncs from YAML":

| Field             | What it does                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **YAML file**     | A file from Export (or a config-io JSON list)                                                                              |
| **Or paste YAML** | The same, pasted                                                                                                           |
| **Mode**          | **Merge: create new syncs and update ones with the same name**, or **Replace: also remove syncs that are not in the file** |
| **Preview**       | Shows the plan: Errors, Create, Update (with the changed fields), Remove, Unchanged                                        |
| **Apply import**  | Applies exactly the last preview. Disabled until you preview, and while there are errors (all or nothing)                  |

"Syncs are matched by name. Updated syncs keep their cursor, so they don't re-pull history. Collections and their
records are never changed by an import." A removed sync's collection is kept.

The repository copy `deploy/config-io/exports/dataset-syncs.yaml` uses the shared object format (one
`kind: DatasetSync` document per sync, with `metadata.name` and `spec`). The Datasets **Import YAML** dialog
expects the `syncs:` list that its own Export writes; import the multi-document file from **Settings →
Configuration (YAML)**, which accepts both formats.

#### How to: add a daily sync for an FMP dataset

Example: a daily **Treasury rates** sync. `macro_daily` waits for `dataset:treasury_rates`, and in the exported
configuration the existing "Treasury rates" sync has its schedule off. On the live stack it runs daily at 19:52
New York time. Without a daily run, `macro_daily` only starts after waiting 24 hours for it.

> **Known gap (ticketed, #369):** the sync sends no `from`/`to`, and FMP then returns only about the last three
> months. Live `treasury_rates` starts on 2026-07-23, so `macro_daily`'s treasury columns (`ust_3m`, `ust_2y`,
> `ust_10y`, `ust_30y` and the curves) are empty for every day before that. Metrics are unaffected (Sharpe uses no
> risk-free rate), but an idea that reads rates sees nothing, and options pricing will need them.

1. Datasets → **Syncs** → **Add dataset sync**.
2. **Name**: `L1 — Treasury rates`. **Source connection**: `FMP`.
3. **Dataset**: `Market · Treasury rates`. The interval switches to its recommended cadence (daily).
4. Leave **Collection** blank (`treasury_rates`) and **Priority** on **Auto** (P0 for this dataset).
5. **Schedule**: **Daily**, **At** `18:40`, **Time zone** `America/New_York`. Check the five next runs.
6. Keep **Sync enabled** ticked and **Create**.
7. To fill it now, click **Run now** on the row (or on the detail page) and watch **Runs**.
8. If the old "Treasury rates" sync is no longer needed, tick it and **Delete** (leave "Also drop these
   collections" unticked: the new sync writes the same collection).

Only datasets in the built-in catalog can be synced. A new FMP endpoint needs a code change: a dataset entry in
`packages/core/src/datasetCatalog.ts` and a known-at rule in `packages/core/src/knownAt.ts` (a unit test refuses
a dataset without one).

#### How to: sync statements for a few tickers only

1. **Add dataset sync**, **Dataset** `Fundamentals · Income statement (quarterly)`.
2. **Symbols**: **Explicit ticker list**, **Tickers** `AAPL, MSFT, NVDA`.
3. **History depth (quarters per symbol)**: `40`. Click **Test depth** to see what the plan returns for AAPL.
4. **Collection**: `income_statement_test` (so the main `income_statement` is not mixed with a test).
5. **Schedule**: **Off**. **Create**, then **Run now**.

### Sync detail page

**How to get there.** Click a row in the Syncs table (`/datasets/syncs/<id>`). **← Syncs** goes back.

The header shows the name, a status pill, "<dataset> · last run … · next …", and the buttons **Catalog**
("Schema, coverage and caveats"), **Run now** and **Edit**. If the last run failed, its error is shown in red
under the header. The page has six tabs.

| Tab                    | What it shows                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source**             | **Dataset** (label and category), **Endpoint** (the FMP stable path, e.g. `historical-price-eod/full`), **Target collection** (links to the Catalog), **Key fields** (the upsert identity, plus an "append-only" pill for weekly snapshots and statements), **Date field**, **History**, **Priority** ("(dataset default)" when automatic), **Retention**, **Description** |
| **Symbols**            | How many symbols the sync covers, without calling FMP. Universe mode, for example: "2,187 symbols incl. 98 delisted · from the sync universe (active screener names + delisted companies)". Preset mode: "Resolved at run time" until a run has counted them. Then "Last run covered N of M symbols (<time>)". Up to 30 sample tickers (largest first)                     |
| **Runs (N)**           | The run history: **Started**, **Trigger** (`schedule`, `manual`, `pipeline`, `event`), **Duration**, **Status**, **Rows**, **FMP calls**, **Symbols** (covered / attempted), **Errors**                                                                                                                                                                                    |
| **History & backfill** | The [backfill panel](#backfills)                                                                                                                                                                                                                                                                                                                                           |
| **Schedule**           | The schedule in words, its time zone, the next five run times, and **Change the schedule**. With no schedule: "No schedule: runs only when started (Run now, bulk run or a pipeline)."                                                                                                                                                                                     |
| **Data**               | The collection's rows in the [data grid](#the-data-grid)                                                                                                                                                                                                                                                                                                                   |

Click a run to open a drawer: status, trigger, duration, rows, FMP calls, the run's error, and **Per-symbol
errors** (the first 50, one row per symbol with its error, for example a plan limit on a non-US symbol:
"FMP plan limit on historical-price-eod/full: this 'symbol' value is not available on the current plan").

A per-symbol run tolerates failing symbols: they are listed, the rest is written, and the run succeeds. Only
when every symbol fails does the run fail ("All 2187 symbols failed (last: …)").

### Backfills

**What it is for.** Pulling long history for a sync in the background, for example ten years of prices, without
blocking the daily syncs. The panel is **History backfill** on the sync detail page (**History & backfill** tab)
and in the edit form.

"Pulls this sync's history in resumable batches at the lowest FMP priority, so scheduled syncs always go first.
It never changes the incremental cursor. Safe to pause, and it resumes after a restart."

| Control                | What it does                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **History from**       | The first date. Default: the sync's **From** date, else ten years ago. The end is today                             |
| **Start backfill**     | Plans the batches and queues the backfill                                                                           |
| Progress bar and line  | "running 42% · 2016-01-01 → 2026-11-10 · batches 37/88 · 51,234 rows · 925 FMP calls · 2,187 symbols · 12 min left" |
| **Pause** / **Resume** | Stops between symbols (checked every 5 symbols) and resumes where it stopped                                        |
| **Cancel**             | Ends it; rows already written stay                                                                                  |
| **Retry failed (N)**   | After it finishes with failed batches, re-queues only those                                                         |

**How it works.**

- **Batches.** Per-symbol datasets: groups of 25 symbols from the sync's symbol list (resolved at start).
  Calendars: 60-day date windows. Index levels: one batch. Other market datasets: one batch for the whole range.
- **Calls.** Prices: one FMP call per symbol per 18 years of range (FMP returns at most about 5,000 daily bars per
  request), so 2016 → today is one call per symbol. Limit-based datasets (statements, metrics): one call per
  symbol at the sync's **History depth**.
- **Progress** is saved after every symbol, so a restart resumes mid-batch. Only one backfill runs at a time in a
  workspace; others wait in the queue.
- **Failures.** A symbol the plan does not serve (non-US listings) is not counted as an error. A batch where more
  than half the symbols fail is marked failed. A calendar window older than the plan's history is **skipped**
  (note: "N window(s) are older than the FMP plan's history and were skipped").
- **Writes** are idempotent upserts on the dataset key, so re-running a backfill is safe.
- **When it ends** it emits `dataset.backfill.completed` with the date range, which triggers the transforms that
  read the collection (see [When it runs](#when-it-runs-triggers-and-schedules)).

**What cannot be backfilled** (Start refuses with the reason):

| Dataset kind                                                                                        | Reason shown                                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Weekly snapshots (estimates, consensus, scores)                                                     | "Weekly snapshot data: FMP keeps no history, so there is nothing to backfill." |
| Feeds (insider, congress, news, grades, price-target changes)                                       | "Latest-items feed: FMP serves no history for it."                             |
| Current values (company profiles, shares float, peers, executives, price-target summary)            | "Current values only: there is no history to backfill."                        |
| Market snapshots without a history parameter (treasury rates, sector performance, movers, economic) | "This market dataset has no history parameter to backfill."                    |

#### How to: backfill five years of prices

1. Datasets → **Syncs** → click **EOD prices (5y, universe)**.
2. **History & backfill** tab. **History from**: today minus five years, e.g. `2021-11-10`.
3. **Start backfill**. With about 2,200 symbols that is about 88 batches of 25 and about 2,200 FMP calls (one per
   symbol). At the shared limit of 250 calls a minute that is roughly 9 minutes when nothing else is running,
   longer when scheduled syncs take the capacity first.
4. Watch the progress line. Pause it if you need FMP capacity for something else; **Resume** later.
5. When it completes, `prices_daily` is triggered for the backfilled range (once `corporate_actions` has also
   completed, or after 24 hours). A window longer than a year runs as yearly chunks in order.

For many syncs at once: tick them in the Syncs table and use **Backfill** in the toolbar.

---

## How syncs work (Layer 1 underneath)

Syncs run inside the API server, not in Python. Every minute the server's dispatcher looks for due syncs,
fires event triggers and starts queued backfills.

### The dataset catalog

Each FMP dataset is a fixed definition in `packages/core/src/datasetCatalog.ts`: endpoint, scope, how it is
pulled incrementally, its key, its date field and its default collection.

**Scope.**

| Scope          | Meaning                                                                        | Examples                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **per-symbol** | One FMP call per symbol of the sync's symbol list                              | EOD prices, statements, profiles, dividends history                                                                                  |
| **market**     | One call (or a few) for the whole market; the **Symbols** column says `Market` | Treasury rates, sector performance, calendars, index levels (four fixed symbols: `^GSPC`, `^VIX`, `^DJI`, `^IXIC`), movers, economic |
| **feed**       | The latest items across the market, paged                                      | Insider trades, congress trades, analyst grades, price-target changes, stock news                                                    |

**Incremental modes.**

| Mode           | How a run pulls                                                                                                                              | Examples                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **timeseries** | Dated history from the cursor (else **From**, else a year ago) to today; on success the cursor becomes today                                 | `eod_prices`, `eod_index`                                                        |
| **window**     | A rolling window re-pulled every run, from **From** (else 7 days ago) to **To** (else 14 days ahead), in 60-day chunks                       | Earnings, dividends and splits calendars                                         |
| **snapshot**   | Current values re-fetched and upserted in place. Datasets marked append-only add a `snapshot_date` to the key, so each weekly pull adds rows | Profiles, statements (limit-based), estimates and consensus (append-only), feeds |

Feeds pull up to 5 pages of 100. Retention, when set, deletes rows older than N days on the date field after
each run.

**The datasets** (default priority from the scheduler; recommended cadence from the catalog; time rule from
`knownAt.ts`):

| Dataset (id)                                                                           | Category                 | Scope / mode                      | Priority | Cadence        | When a row is known                                                                         |
| -------------------------------------------------------------------------------------- | ------------------------ | --------------------------------- | -------- | -------------- | ------------------------------------------------------------------------------------------- |
| Universe (screener) (`universe`)                                                       | Reference                | market / snapshot                 | P0       | weekly         | current only                                                                                |
| EOD prices (OHLCV) (`eod_prices`)                                                      | Prices                   | per-symbol / timeseries           | P0       | daily          | `date` at the 16:00 ET close, same date                                                     |
| Index & VIX levels (`eod_index`)                                                       | Prices                   | market / timeseries               | P0       | daily          | close, same date                                                                            |
| Treasury rates (`treasury_rates`)                                                      | Market                   | market / snapshot                 | P0       | daily          | close, same date                                                                            |
| Sector performance (`sector_performance`)                                              | Market                   | market / snapshot                 | P0       | daily          | close, same date                                                                            |
| Earnings calendar (`earnings_calendar`)                                                | Calendars                | market / window                   | P0       | daily          | report `date`, usable from the next session close                                           |
| Dividends calendar / history                                                           | Calendars                | market window / per-symbol        | P0       | daily / weekly | `declarationDate` (else `date`), next session                                               |
| Splits calendar / history                                                              | Calendars                | market window / per-symbol        | P0       | daily / weekly | the day before the ex-date                                                                  |
| Insider trades (`insider_trades`)                                                      | Ownership                | feed                              | P1       | daily          | `filingDate`, next session                                                                  |
| Congress trades — Senate / House                                                       | Ownership                | feed                              | P1       | daily          | `disclosureDate`, next session                                                              |
| Analyst grade changes, Price target changes                                            | Estimates                | feed                              | P1       | daily          | `publishedDate`, next session                                                               |
| Stock news (`news_stocks`)                                                             | Market                   | feed                              | P2       | daily          | `publishedDate`, next session                                                               |
| Income statement, Balance sheet, Cash flow (quarterly)                                 | Fundamentals             | per-symbol / snapshot (limit 8)   | P1       | weekly         | `acceptedDate` (SEC acceptance); placeholder → period end + 45 days (Q1–Q3) or + 90 (Q4/FY) |
| Key metrics (annual), Financial ratios (annual), Financial growth (quarterly)          | Fundamentals             | per-symbol / snapshot             | P1       | weekly         | period end + 90 days                                                                        |
| Enterprise values, Owner earnings                                                      | Fundamentals             | per-symbol / snapshot             | P1       | weekly         | period end + 90 days                                                                        |
| Revenue by product / by geography                                                      | Fundamentals             | per-symbol / snapshot             | P2       | weekly         | period end + 90 days                                                                        |
| Analyst estimates (annual), Price target consensus, Grades consensus, Financial scores | Estimates / Fundamentals | per-symbol / append-only snapshot | P1       | weekly         | `snapshot_date` (no history before the first snapshot)                                      |
| Market capitalization (`market_cap`)                                                   | Reference                | per-symbol / snapshot             | P1       | daily          | close, same date                                                                            |
| Historical market cap (`historical_market_cap`)                                        | Reference                | per-symbol / snapshot (limit 500) | P1       | weekly         | close, same date                                                                            |
| Employee count                                                                         | Reference                | per-symbol / snapshot             | P2       | weekly         | `filingDate`, next session                                                                  |
| Company profiles, Shares float, Price target summary                                   | Reference / Estimates    | per-symbol / snapshot             | P1       | weekly         | current only                                                                                |
| Stock peers, Key executives                                                            | Reference                | per-symbol / snapshot             | P2       | weekly         | current only                                                                                |
| Biggest gainers, Most active                                                           | Market                   | market / snapshot                 | P2       | daily          | current only                                                                                |
| Economic — GDP / CPI                                                                   | Market                   | market / snapshot                 | P2       | weekly         | period end + 45 days (GDP) / + 20 days (CPI)                                                |

The universe sync also writes `delisted_companies` (known on its `delistedDate`).

### The sync universe

The **Universe (screener)** sync (`L1 — Universe (screener)`, weekly, Saturday 04:55 ET in this deployment)
builds the `universe` collection:

1. **Active names**: the FMP company screener for NASDAQ, NYSE and AMEX, actively trading, not ETFs or funds,
   market cap above $2B (up to 5,000 rows). Fields: `symbol`, `companyName`, `marketCap`, `exchange`, `sector`,
   `industry`, `is_delisted: false`.
2. **Delisted names**: the FMP delisted-companies list, paged. The current plan serves page 0 only (page 1 is a
   402), so the sync keeps what page 0 returns. These are also written to `delisted_companies`. Only delisted
   names from the same exchanges join the universe (`is_delisted: true`, `delisted_date`).
3. **Merge**: an active row overrides a delisted row for the same symbol.

Rows are upserted and never removed, so a name that later falls below $2B stays in the sync universe. In this
deployment the universe holds roughly 2,000 to 2,250 symbols, delisted names included. Every per-symbol sync in
**Reuse the Universe collection** mode iterates all of them, so one daily EOD run is about 2,200 FMP calls.

The universe is deliberately broad. The point-in-time filter (price, liquidity, market cap and exchange on each
date) is the research universe, `universe_daily`, built in Layer 2.

### What one run does

1. A run record is created (visible in **Runs**).
2. The FMP key is read from the connection URL (`apikey=`). A connection without one fails: "The selected FMP
   connection has no apikey in its URL".
3. The symbols are resolved (universe, preset via the screener, or the list). With an empty universe: "No universe
   yet: sync the Universe dataset first, or use an explicit symbol list".
4. Each response is **validated** against the collection's last known schema (below), then upserted on the
   dataset's key with a `_syncedAt` time. Rows already there are updated in place, so repeated runs never
   duplicate.
5. On success: the run is `succeeded` with rows, FMP calls, symbols attempted and covered, and the first
   per-symbol errors; the cursor moves to today (time series); the failure counter resets; the Catalog entry is
   refreshed; and a `dataset.sync.completed` event is emitted with the collection and date range. That event
   starts the transforms, syncs and pipelines waiting for it.
6. On failure: the run is `failed` with the error, the sync's `lastError` is set (status **failed** in the
   table), the failure counter goes up, and `dataset.sync.failed` is emitted.

A run interrupted by a server restart is marked failed with "Interrupted by a server restart".

### Rate limit, priorities and the queue

- **One FMP rate limit for all syncs**: 250 requests a minute by default (`DATASET_SYNC_RPM`). The next slot
  always goes to the highest-priority waiter: P0 before P1 before P2, and backfills last (a fourth level,
  BACKFILL). P2 can never starve P0.
- **A background queue** runs at most 3 syncs at once (`DATASET_SYNC_CONCURRENCY`), highest priority first. A
  sync is never queued or run twice at the same time ("already running" in bulk Run).
- **Throttles**: an FMP 429 (or a 402 that is really a throttle) pauses every sync for the backoff time, then the
  request is retried (up to 8 attempts, backoff doubling up to 60 seconds). 500, 502, 503 and 504 are retried
  the same way without pausing the others.

### Schema checks and drift

Before writing, every FMP response is checked against the fields the Catalog knew when the pull started. An
error-shaped answer fails that item. Differences are **drift**: a missing field, a new field, a changed type, or
a rising null rate. Drift on a key or date field is **breaking**: those items are not written and the error says
"Schema drift in <collection>, not written: …". Other drift is written and recorded as an alert in **Health →
Drift alerts**, where an administrator can **Resolve** it.

### Plan limits, failures and the pause

Some FMP answers are a **plan limit**, not a failure. FMP answers 402 with "Premium Query Parameter", "Special
Endpoint", "Special Parameters … not available under your current subscription" when a parameter value is outside
the plan (a page above 0 on a feed, an old `from` on a calendar, a non-US symbol), and "Restricted Endpoint" when
the endpoint is not in the plan. StockHarness turns these into an **FmpPlanLimit** error, for example:

```
FMP plan limit on news/stock-latest: this 'page' value is not available on the current plan
FMP endpoint grades-latest-news is not in the current plan
```

A plan limit is final: it is never retried and it does not slow the other syncs. Where it is expected, the sync
keeps what it got: a feed stops at the last page the plan serves, a delisted-companies page limit ends the list,
a non-US symbol is skipped, a backfill window older than the plan's history is skipped.

**When a scheduled run fails**, the next attempt depends on the kind of failure:

| Failure                                                               | Next attempt                                                                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A normal error (network, FMP 5xx after retries, all symbols failed …) | Back off: 5 minutes after the 1st failure in a row, 15 minutes after the 2nd, 60 minutes after the 3rd and later, but never later than the next regular slot |
| A plan limit, 1st or 2nd in a row                                     | The next regular slot (no early retry: the answer cannot change)                                                                                             |
| A plan limit, 3rd in a row                                            | The schedule is **paused**: switched off, with the reason "Paused after 3 runs in a row hit an FMP plan limit: <error>"                                      |

The counter resets on the next successful run. Manual runs (**Run now**) count toward the counter but do not
reschedule anything.

**What you see when a sync is paused.** On the Syncs tab: **Status** `failed` and **Schedule** `Off`; the error
on the detail page. The pause reason itself is shown on the **Map** page's source card. Health counts the sync
under **Failing**; once its last planned slot is more than an hour past, it is also counted as late.

#### How to: find out why a sync is paused

1. Datasets → **Syncs**. Use **Filters → Status: failed** and look for rows whose **Schedule** is `Off`. (Or
   open the **Map** page: a paused source card shows "Paused after 3 runs in a row hit an FMP plan limit: …".)
2. Open the sync. The red notice under the header is the last error, for example "FMP plan limit on
   earnings-calendar: this 'from' value is not available on the current plan".
3. **Runs** tab: check the last three runs. Open one for the per-symbol errors.
4. Decide from the error and [data coverage](#what-the-current-fmp-plan-gives):
   - A parameter outside the plan (an old **From** on a calendar, too deep a **History depth**): edit the sync to
     stay inside the plan. Use **Test depth** for per-symbol datasets.
   - An endpoint not in the plan ("is not in the current plan"): disable or delete the sync; a plan upgrade is
     the only fix.
5. **Edit** → **Schedule**: choose the mode again (e.g. **Daily**) and **Save**. Then **Run now** to confirm.
   The failure counter resets only on a successful run, so if the next run hits the same plan limit the schedule
   pauses again at once.

### What the current FMP plan gives

From `docs/data-coverage.md` (probed live on 2026-11-06):

| Available                                                | Notes                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Daily prices, US common stocks (NASDAQ, NYSE, AMEX)      | 2016 onwards; delisted names included                                                 |
| Index levels (`^GSPC`, VIX) and treasury rates           | The benchmark and macro regimes (`macro_daily`)                                       |
| Quarterly income statement, balance sheet, cash flow     | About 10 years per symbol → `fundamentals_pit`                                        |
| Annual key metrics, ratios, growth, scores               | Annual only: the plan refuses quarterly key metrics                                   |
| Analyst estimates (annual), price-target summary, grades | Snapshots; estimates history from about 2022, so theories using them are forward-only |
| Earnings history per symbol (EPS actual vs estimate)     | About 40 quarters; not synced yet (#304)                                              |
| Dividends and splits history per symbol                  | → `corporate_actions`                                                                 |
| Insider trades, congress trades, news, movers            | Feeds                                                                                 |

| Limit of the plan                                        | What the platform does                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| No S&P 500 / Nasdaq / Dow constituents (current or past) | The S&P 500 proxy: the 500 largest by market cap on each date, from `universe_daily`                    |
| News feeds serve `page=0` only                           | Feed syncs keep page 0 and record the limit                                                             |
| Calendars serve the last ~12 months                      | Kept as a rolling year; history comes from the per-symbol syncs (`dividends_history`, `splits_history`) |
| Non-US listings (LSE, TSX, OTC …)                        | Left out of the universe                                                                                |
| Delisted-companies list: page 0 only                     | The universe takes what the plan returns                                                                |

---

## Catalog tab

**What it is for.** One machine-readable page per collection: what it holds, its fields with descriptions and
units, when its rows became known, how complete it is, its known problems, and how it joins to others. Agents
read the same entries (the `describe_collection` tool), and every point-in-time read in the platform uses the
time rule shown here.

**How to get there.** Datasets → **Catalog** (`/datasets/catalog`), or **Catalog** on a sync's detail page, or
a collection name anywhere in the Datasets page. A collection appears after its first sync or transform run;
until then: "The catalog is empty".

The Catalog entry is refreshed automatically after every sync run, backfill and transform run (row count, a
sample of 300 rows for field types and null rates, date range, symbols, universe coverage). Your edits (curated
docs) are kept separately and never overwritten.

### The collection list (left)

| Control                   | What it does                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------- |
| **Search collections**    | Filters by name and description                                                        |
| **Lineage graph**         | Opens the [full lineage graph](#lineage-graph)                                         |
| **Export for agents (N)** | Downloads `catalog-for-agents.md`: exactly what agents see, for the ticked collections |
| Groups                    | **Layer 1 · raw**, **Layer 2 · prepared**, **Other**, each with "N · X% documented"    |
| Each row                  | A checkbox (for the export), the name, and "rows · % of fields documented"             |

### The collection page (right)

**Header.** The name, a layer pill, a **time-rule pill**, and facts:

| Fact            | Meaning                                                              | Example (`prices_daily`)                                                          |
| --------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Description     | Click the pencil to edit (administrators)                            | "One row per security and trading day: OHLCV, adj_* on the current share basis …" |
| **Grain**       | One row per what; editable                                           | `security × trading day`                                                          |
| **Key**         | The unique key                                                       | `security_id`, `date`                                                             |
| **Time rule**   | When rows became known, in words                                     | "`known_at` / `as_of_date` on every row; filter `as_of_date <= D`."               |
| **Freshness**   | Last update and its status (`ok` / `failed`)                         |                                                                                   |
| **Produced by** | The sync or transform that writes it (transforms link to the editor) | transform prices_daily                                                            |

**Time-rule pills:**

| Pill                  | Meaning                                                                                    | Reads for a past date D             |
| --------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------- |
| **point-in-time**     | Each row has a known-at rule (Layer 1) or carries `as_of_date` (Layer 2)                   | Cut at D by the rule                |
| **current only**      | Holds today's value only (`universe`, `company_profiles`, `shares_float`, `stock_peers` …) | Refused                             |
| **static**            | Reference data that does not change over time (`trading_calendar`)                         | Uncut                               |
| **time rule unknown** | No producer declares when rows became known (e.g. a collection made by hand)               | Refused: "do not use for backtests" |

**Tabs.**

| Tab             | What it shows and lets you do                                                                                                                                                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fields (N)**  | Every field: **Field**, **Type**, **Null %**, **Example**, **Description**, **Unit**. Administrators edit the description and unit in place; the change saves when you leave the box (Enter also saves). A robot icon means the text was auto-filled from the built-in field dictionary; "undocumented" means no description at all       |
| **Coverage**    | KPI cards **Rows**, **Symbols**, **Universe coverage**, **Range (<date field>)**; charts **Rows per day**, **Symbols per day**, and a heatmap "Gaps: average symbols per day, by year and week" ("Pale or missing cells are weeks with little or no data"). Computed in the background and cached for 6 hours; **Recompute** refreshes it |
| **Caveats (N)** | Known problems, each with a severity (`info`, `warn`, `blocking`), its source (`plan`, `data`, `curated`) and the issue that would lift it. Administrators can dismiss a built-in caveat (×), **restore all**, or add one: severity, "Add a known data problem…", **Add caveat**                                                          |
| **Sample**      | The rows, in the [data grid](#the-data-grid)                                                                                                                                                                                                                                                                                              |
| **Joins (N)**   | Known joins: Layer 1 by `symbol` to `securities` (ticker validity intervals); Layer 2 by `security_id` to `securities`, and by `security_id` + `date` to `prices_daily`                                                                                                                                                                   |
| **Lineage**     | The lineage graph narrowed to what feeds this collection and what it feeds                                                                                                                                                                                                                                                                |
| **Agent view**  | "Exactly what `describe_collection` returns to an agent · about N tokens", with **Copy**                                                                                                                                                                                                                                                  |

**Built-in caveats** (attached automatically):

| Id                   | Severity | Applies to                                                                             | Text (short)                                                                           |
| -------------------- | -------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `delisted-coverage`  | warn     | Per-symbol collections, `universe`, `securities`, `prices_daily`, `delisted_companies` | Survivorship bias: the plan serves only page 0 of delisted companies (about 100 names) |
| `index-constituents` | info     | `universe`, `securities`                                                               | No S&P 500 / Nasdaq / Dow membership on the plan; the screener universe stands in      |
| `annual-only`        | info     | `analyst_estimates`, `key_metrics`, `ratios`                                           | Annual values only                                                                     |
| `snapshot-history`   | blocking | Weekly snapshot collections                                                            | No history before the first snapshot; strategies built on it are forward-only          |
| `feed-history`       | blocking | Feed collections                                                                       | History starts when the sync started                                                   |
| `earnings-timing`    | warn     | `earnings_calendar`                                                                    | Before-open / after-close timing unknown: react at the next session close              |
| `statement-depth`    | warn     | Statements, `financial_growth`                                                         | Quarterly history is short until the 40-quarter backfill                               |
| `current-sector`     | warn     | `securities`, `company_profiles`, `universe`                                           | Sector and industry are the current classification, not point in time                  |

On live, the sync universe holds **168 delisted names of 2,288** (page 0 of the delisted list plus names that
delisted while being synced), so survivorship bias is reduced but not gone.

Dismiss a built-in caveat when it no longer applies, for example `statement-depth` once the statement syncs run
with **History depth** 40 (as they do here).

Curated docs (description, grain, field docs, caveats, dismissed caveats) are a YAML object, `kind:
CatalogEntry`, exported and imported with everything else (repository copy:
`deploy/config-io/exports/catalog.yaml`). A transform's `oh.describe(...)` call writes curated docs too.

### Known-at rules and point-in-time reads

Every point-in-time read uses the collection's rule from the Catalog: the strategy reader
(`ctx.read_df`), the agent data tools (`query_collection`, `sample_collection`) and collection bindings. The
rule gives each row a `known_at` (a UTC instant) and an `as_of_date` (the first session that opens after it). A
read for date D keeps rows with `as_of_date <= D`. Without the trading calendar, "next session" means the next
weekday; readers that have `trading_calendar` also skip holidays.

| Rule         | Used by                                                                                                                                            | known_at                                   | Worked example                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| End of day   | Prices, index levels, treasury, sector performance, market cap                                                                                     | `date` at 16:00 ET                         | AAPL close of 2024-08-02 → usable 2024-08-02                                                                                                                                                    |
| Timestamp    | Insider (`filingDate`), congress (`disclosureDate`), grades and news (`publishedDate`), dividends (`declarationDate`, else `date`), employee count | That time (a bare date counts as 16:00 ET) | A Form 4 filed Friday 2024-08-02 18:30 ET → usable Monday 2024-08-05                                                                                                                            |
| Statement    | Income statement, balance sheet, cash flow                                                                                                         | `acceptedDate` (SEC acceptance)            | AAPL quarter ended 2024-06-29, accepted 2024-08-02 18:04 ET → usable 2024-08-05. If `acceptedDate` equals the period end it is a placeholder: period end + 45 days (Q1–Q3) or + 90 days (Q4/FY) |
| Period lag   | Key metrics, ratios, growth, enterprise values, owner earnings, segments (+90 days); GDP (+45); CPI (+20)                                          | Period end + lag                           | FY ended 2023-09-30 → known 2023-12-29 → usable the next session                                                                                                                                |
| Next session | Earnings calendar                                                                                                                                  | Report `date`                              | Reported 2024-10-31 (time of day unknown) → act at the next session close                                                                                                                       |
| Day before   | Splits                                                                                                                                             | The day before the ex-date                 | NVDA 10-for-1, ex-date 2024-06-10 → known 2024-06-09 → usable 2024-06-10                                                                                                                        |
| Snapshot     | Estimates, consensus, scores                                                                                                                       | `snapshot_date`                            | Nothing before the first weekly snapshot                                                                                                                                                        |
| As of        | Layer 2 outputs                                                                                                                                    | The row's own `as_of_date`                 | `prices_daily` row of 2024-08-02 has `as_of_date: 2024-08-02`                                                                                                                                   |
| Current only | Universe, profiles, float, peers, executives, price-target summary, movers                                                                         | none                                       | Refused for any historical date                                                                                                                                                                 |

Layer 2 is optional because Layer 1 reads get the same guarantee. A strategy may read `income_statement`
directly and only sees statements accepted before its date.

### Lineage graph

**How to get there.** Catalog → **Lineage graph** (`/datasets/catalog/_graph`), or the **Lineage** tab of a
collection (narrowed to it).

"Lineage: what feeds what, from dataset syncs through transforms to every output collection." Three kinds of
boxes: syncs, collections and transforms, left to right, with edges sync → collection → transform → collection.
The bar reads "N syncs · N collections · N transforms. Borders show freshness; hover a node for its last run."

- Each box shows a freshness pill (`fresh`, `stale`, `failed`, `pending` for unknown), rows for collections,
  the last run time for syncs and transforms, and "disabled" when off.
- **Hover** for the last run, its status, rows written and any error.
- **Click** a box to highlight everything upstream and downstream of it (the rest dims); **Open <kind>** opens it.
- **Double-click** opens the collection's Catalog page, the transform editor, or the Syncs list.

Example: click `universe_daily` to see that it depends on `prices_daily`, `securities`,
`historical_market_cap` and `fundamentals_pit`, and back through them on `eod_prices`, `corporate_actions` and
the statement syncs, and that `features_daily` and `features_ranked` depend on it.

### The data grid

Used on a sync's **Data** tab and a collection's **Sample** tab. It reads the workspace MongoDB through the
built-in MongoDB connection; without it: "Connect the built-in MongoDB to browse this collection."

- 25 rows a page; "1–25 of 4,812,330"; **Previous** / **Next**.
- Click a column header to sort (server side), again to reverse.
- **Columns** hides or shows columns. `_id` comes first and `_syncedAt` last.
- Nested objects and arrays open as embedded JSON.
- **Export this page as CSV** downloads the visible page (`<collection>-<first row>.csv`).
- **Refresh** reloads.

For filters and edits on any collection, use **Knowledge → Collections** in the sidebar (filter and sort with
MongoDB JSON, insert JSON, edit or delete records, indexes). Be careful there with Layer 1 and Layer 2
collections: syncs and transforms own them.

---

## Transforms tab

**What it is for.** Layer 2: "Python transforms that turn Layer 1 data into flat, point-in-time collections, the
data research and simulations read. One transform can write several collections."

**How to get there.** Datasets → **Transforms** (`/datasets/transforms`).

A transform is a versioned object: Python code, its inputs, its declared outputs, when it runs, how it handles
dates, parameters and secret names. Every save is a new version. Its code runs in the Python executor (a fresh
container per run on Kubernetes) with the `oh` helpers and the `pipeline` package baked into the image, so the
real transforms are a few lines that call `pipeline.layer2.<name>.compute`.

### The list

A three-step explainer sits at the top:

1. **New data arrives.** A Layer 1 sync finishes, or another transform does.
2. **The transforms that read it run by themselves**, in order. One with several inputs waits for all of them (at
   most 24 hours).
3. **Each writes its output collections**, every row stamped with when it became known.

**KPI cards:** **Transforms** ("N enabled"), **Runs today**, **Failed today** ("needs attention" when above 0),
**Rows written today**.

| Column                             | What it shows                                        | Example                                                                               |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Name**                           | Name and version; a `disabled` pill when off         | `prices_daily` v2                                                                     |
| **Reads**                          | Declared inputs                                      | `securities` `corporate_actions` `eod_prices`                                         |
| **Writes (click to see the rows)** | Outputs; a click opens the collection in the Catalog | `prices_daily`                                                                        |
| **When it runs**                   | A sentence                                           | "Automatically, after new eod_prices data and the corporate_actions transform arrive" |
| **Last run**                       | Status and time, or "Never"                          |                                                                                       |
| **Rows**                           | Rows written by the last run                         |                                                                                       |
| **Duration**                       | Of the last run                                      | `48.3 s`, `4 min`                                                                     |
| (action)                           | **Run now (last day)**                               |                                                                                       |

The header has **Export** / **Import** (transforms as YAML, shared object format) and **New transform**. The page
refreshes every 4 seconds while a run is queued or running.

### New transform: templates

**New transform** opens a picker. Each template is a complete transform you can save as is and adapt:

| Template          | What it shows                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Blank**         | One input, one point-in-time output (`my_transform`: `eod_prices` → `my_output`)                                                                      |
| **Join**          | Join prices and market cap on symbol and date with DuckDB (`prices_with_mcap`)                                                                        |
| **Flatten**       | Split one nested Layer 1 dataset into several flat collections (`company_profiles` → `company_identity`, `company_classification`, `company_listing`) |
| **Feature**       | Rolling features per symbol, with a 60-day lookback so the first window day is complete (`momentum_features`)                                         |
| **Snapshot diff** | Record what changed between two snapshots of a current-only dataset (`profile_changes`, append mode, plus a static `profile_snapshot`)                |

### The editor

**How to get there.** Click a transform's name (`/datasets/transforms/<name>`).

**Header:** **← Transforms**, the name and version, "unsaved changes" when the draft differs, "Part of
pipelines: …" (with each pipeline's last status for this node), and the actions:

| Button                        | What it does                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------- |
| **Export** / **Import**       | This transform as YAML                                                           |
| **Preview**                   | "Run the current code on a sample (20 symbols, 1 year) without writing anything" |
| **Run now**                   | Opens the run dialog for the saved version                                       |
| **Create** / **Save version** | Saves; disabled while there are blocking problems or nothing changed             |
| (bin) **Delete transform**    | "Delete <name>? Its output collections are kept."                                |

**Validation bar.** Red pills for blocking problems ("Every output needs a collection name", "<output>: needs a
key", "<output>: needs a known_at field unless static", "Params is not valid JSON"). With no problems it says
"Preview runs the current code on 20 symbols × 1 year and checks every output. Nothing is written." After a
preview it lists each output's checks (below).

The editor has three panes.

**Inputs (left).** One entry per input collection, with its layer and row count ("L1 · 4,812,330", or a red "?"
when it is not in the catalog yet). Expand an input to tick fields, then **Insert oh.read_df** to insert a read
with that projection and the window filter at the cursor:

```python
eod_prices = oh.read_df("eod_prices", {"date": {"$gte": oh.window.start, "$lte": oh.window.end}} if oh.window else {}, columns=["symbol", "date", "close"])
```

**+ Add input…** lists every catalog collection grouped by layer.

**Code (middle).** `main.py` in a code editor. When the latest run (of this version) or the latest preview
failed, the traceback line is marked and shown in the toolbar ("line 12: KeyError: 'adj_close'").

**Configuration (right),** in collapsible sections:

| Section                 | Field                                                    | What it does                                                                                                                                                                                                            | Example (`prices_daily`)                                    |
| ----------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Basics**              | **Name**                                                 | "Lowercase, digits and underscores"                                                                                                                                                                                     | `prices_daily`                                              |
|                         | **Description**                                          | Free text                                                                                                                                                                                                               | "Split- and dividend-adjusted point-in-time daily prices …" |
|                         | **Enabled (scheduled and triggered runs)**               | Unticked: only manual runs                                                                                                                                                                                              | ticked                                                      |
| **Outputs (N)**         | collection name                                          | One card per output; **Add output** adds one, × removes                                                                                                                                                                 | `prices_daily`                                              |
|                         | **Key**                                                  | "Comma-separated"; the upsert identity                                                                                                                                                                                  | `security_id, date`                                         |
|                         | **Write mode**                                           | `upsert` (by key; unchanged rows skipped by content hash), `append` (insert), `replace` (empty the collection, then insert)                                                                                             | `upsert`                                                    |
|                         | **Static reference data (no point-in-time fields)**      | For data with no time (a calendar)                                                                                                                                                                                      | unticked                                                    |
|                         | **known_at field**                                       | Required unless static; every row must have it                                                                                                                                                                          | `known_at`                                                  |
|                         | **as_of field**                                          | The first usable date; readers filter on it                                                                                                                                                                             | `as_of_date`                                                |
|                         | **Description**, **Grain** ("e.g. symbol x trading day") | Catalog docs                                                                                                                                                                                                            | `security × trading day`                                    |
|                         | **Field docs**                                           | JSON: `{ "ret_1d": { "description": "1-day return", "unit": "ratio" } }`                                                                                                                                                |                                                             |
| **Trigger: <summary>**  | **Run on a schedule**                                    | A clock schedule: **How often** (Every minute … Every week, Custom interval), **On**, **At**, **Time zone**, and "Next run …". (The **Message to send** box is shared with agent schedules and not used by transforms.) | off                                                         |
|                         | **Run after**                                            | "Comma-separated: dataset:<collection> or transform:<name>"                                                                                                                                                             | `dataset:eod_prices, transform:corporate_actions`           |
|                         | (status)                                                 | "Runs when all of these have completed (settled for a minute): last triggered …" with a pill per upstream: "done <time>" or "waiting"                                                                                   |                                                             |
| **Incremental: <mode>** | **Mode**                                                 | `full` (recompute everything; no window) or `date_range` ("date_range runs get oh.window")                                                                                                                              | `date_range`                                                |
|                         | **Lookback (trading days)**                              | Extra history loaded before the window; only the window is written                                                                                                                                                      | `10`                                                        |
| **Params and secrets**  | **Params (JSON)**                                        | "Available to the code as oh.params"                                                                                                                                                                                    | `{}` (see `universe_daily` below)                           |
|                         | **Secrets**                                              | "Comma-separated Python secret names (Settings → Python secrets); values are never stored here"                                                                                                                         | none                                                        |

**Bottom panel** (saved transforms):

| Tab                 | What it shows                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Latest run**      | Status, version, trigger, time, window, duration, "N more queued", **Refresh**; sub-tabs **Outputs** (per collection: **Read**, **Written**, **Unchanged**, **DQ issues**), **stdout**, **stderr**                                                         |
| **Run history (N)** | **Started**, **Version**, **Trigger**, **Window** ("full" for full mode), **Status**, **Read**, **Written**, **DQ**, **Duration**. Click a run for a drawer with outputs, its DQ issues (issue, severity, collection, symbol, date), stdout and stderr     |
| **Versions (N)**    | Every version with **Saved** time and note; **Restore** saves an old version as a new one; a side-by-side diff (**Compare** vN **with** vM, **Code** or **Settings**); **Export with history** downloads YAML with every version (an import restores them) |

While a transform backfill runs, a **Backfill** bar above the tabs shows "N of M chunks · rows written · running
<window>", and "chunk <start> failed; later chunks wait" if one fails.

### Preview

**Preview** runs the current draft (saved or not) in the executor with writes captured instead of stored.

- **Sample**: the 20 largest names of the universe (by market cap) and the last year (plus the lookback). Reads
  of collections that have a `symbol` field are narrowed to those 20 symbols. Collections without one (Layer 2
  tables keyed by `security_id`, such as `prices_daily`) are read in full for the window, so a preview of a
  transform that reads them can take longer.
- **Checks per output**: rows on the sample (warn when none), the key is set on every row, the key is unique,
  `known_at` is present on every row, the schema matches the last run (warn when fields were added, removed or
  changed type), and fields that are mostly null (above 50%).
- **The Preview panel**: an output switcher, and tabs **Rows (N of M)**, **Schema** (field, type, null %), **DQ
  issues**, **Logs**. "nothing written" is always in the header. Previews expire after a day.

A preview made before you changed the code is marked "code changed since this preview".

### The run dialog

**Run now** (editor) opens "Run <name> v<version>". A full-mode transform: "This is a full-mode transform: it
recomputes all its outputs in one run." A date-range transform offers **Range**:

| Range                                       | What it queues                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Last day**                                | One run with the window = today                                                                                                                               |
| **Custom range (one run)**                  | One run for **Start** → **End** (End defaults to today)                                                                                                       |
| **Full backfill (yearly chunks, in order)** | One run per calendar year from **Start** (default: 10 years ago) to **End**. Chunks run one after the other; a failed chunk stops the rest, which stay queued |

**Queue run** queues them. The list's **Run now (last day)** is the same as **Last day**.

### When it runs: triggers and schedules

A transform runs in three ways.

**1. After its upstreams ("Run after").** Each entry is `dataset:<collection>` (a sync writing that collection
completed, or a backfill of it) or `transform:<name>` (that transform completed). The dispatcher works like this:

1. A completion event is recorded on every enabled transform that lists it, as a pending mark with the event's
   date range (a sync's `cursor → today`, a backfill's `from → to`, a transform's window). If the same upstream
   completes twice before the run, the widest range is kept.
2. When **every** listed upstream has a mark, and no new event arrived for 60 seconds (the debounce,
   `TRANSFORM_TRIGGER_DEBOUNCE_SECONDS`), the marks are cleared and one run is requested.
3. **Waiting up to 24 hours.** If one upstream completed and the others have not within 24 hours
   (`TRANSFORM_TRIGGER_MAX_WAIT_HOURS`), for example because a sync is disabled or broken, the transform runs on
   what has arrived and logs which upstream it ran without.
4. **The window** is the union of the pending marks' ranges: the earliest start to the latest end (today when no
   mark has a range). A window longer than 366 days runs as a full backfill in yearly chunks.

Saving refuses a trigger on a collection no sync writes ("Trigger dataset:x: no dataset sync writes x"), on an
unknown transform, on itself, and trigger cycles ("Trigger cycle: a → b → a (each would keep triggering the
next)").

**2. On a schedule.** **Run on a schedule** with a clock. A scheduled date-range transform runs the last day.
`trading_calendar` is the only scheduled transform here: every 30 days at 05:00 UTC.

**3. By hand.** **Run now**, or a pipeline node.

Runs go to a background queue (2 at a time, `TRANSFORM_CONCURRENCY`), each with a one-hour timeout
(`TRANSFORM_TIMEOUT_SECONDS`). A disabled transform still runs when you start it by hand. A run interrupted by a
restart is marked failed ("Interrupted by a server restart"); run it again.

**Worked example: the daily chain.** In this deployment, on a weekday evening (ET):

| Time     | What happens                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 18:28    | `L1 — Dividends calendar` runs                                                                                                       |
| 18:49    | `EOD prices (5y, universe)` runs: about 2,200 FMP calls, from the cursor (yesterday) to today                                        |
| 19:45    | `L1 — Splits calendar` runs                                                                                                          |
| ~19:46   | `corporate_actions` has both its upstreams (`dataset:dividends_calendar`, `dataset:splits_calendar`); 60 s later it runs (full mode) |
| after it | `prices_daily` has `dataset:eod_prices` and `transform:corporate_actions`; it runs for the eod window with a 10-trading-day lookback |
| after it | `universe_daily` (after `transform:prices_daily`), then `features_daily`, then `features_ranked`                                     |

Weekly, after the Saturday statement syncs, `fundamentals_pit` runs once all three statements have completed.

### Where results go

Each declared output is a collection in the workspace database. The `oh` helpers enforce the declaration:

```python
import oh

w = oh.window                       # start, end, lookback_start (ISO dates); None in full mode
oh.output("prices_daily").upsert(rows)       # uses the output's key, write mode and known_at field
oh.dq("stale_price", "warn", security_id="SEC_000008", date="2026-11-03")
oh.describe("prices_daily", fields={"adj_close": {"description": "Split-adjusted close", "unit": "USD"}})
```

- Writing to any collection that is not a declared output raises `PermissionError`.
- `upsert` skips rows whose content did not change (content hash) and reports **Written** and **Unchanged**.
- A row without its `known_at` field is refused (unless the output is static).
- `oh.dq(...)` writes data-quality issues to `dq_issues`, one row per (collection, issue type, security,
  date), so re-runs never duplicate them. DQ issues never fail a run; pipeline gates decide.
- `oh.describe(...)` becomes curated Catalog docs after a successful run.
- After every successful run, each output's Catalog entry is refreshed and `transform.completed` is emitted, which
  triggers the next transforms.
- A transform cannot write a collection a sync writes ("a transform must write its own collection") or one
  another transform produces (one producer per collection), and an input cannot also be an output.
- With **Write mode** `replace`, each call to `upsert` empties the collection first, so call it once with all
  rows.

### The transforms in this deployment

All live in `pipeline/layer2/` (logic) and `deploy/config-io/exports/transforms.yaml` (the objects).

| Transform           | Reads                                                                     | Writes (key)                                                            | Runs                                                          | Mode                     | What it does                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trading_calendar`  | none                                                                      | `trading_calendar` (`date`), static                                     | every 30 days, 05:00 UTC                                      | full                     | NYSE sessions from 1990 to the end of next year: open and close in UTC, early closes, previous and next session (from `exchange_calendars`)                                                      |
| `securities`        | `company_profiles`, `delisted_companies`, `eod_prices`                    | `securities` (`security_id`)                                            | after `dataset:company_profiles`                              | full                     | The securities master: one row per security with an immutable `security_id`, matched by CIK, then CUSIP, then ticker + name. Tickers, sectors, industries and exchanges are validity intervals   |
| `corporate_actions` | `securities`, dividends and splits calendars and histories                | `corporate_actions` (`security_id`, `action_type`, `ex_date`)           | after `dataset:dividends_calendar`, `dataset:splits_calendar` | full                     | Splits and dividends keyed to `security_id`; dividends classed cash or special; `split_ratio` new/old (4-for-1 = 4.0)                                                                            |
| `prices_daily`      | `securities`, `corporate_actions`, `eod_prices`                           | `prices_daily` (`security_id`, `date`)                                  | after `dataset:eod_prices`, `transform:corporate_actions`     | date_range, lookback 10  | Split-adjusted OHLC (`adj_*`), `ret_1d`, total return `tr_1d`, `dollar_volume`, `dq_flags`. A security with a new split gets its whole history rewritten                                         |
| `fundamentals_pit`  | `securities`, `trading_calendar`, the three statements                    | `fundamentals_pit`                                                      | after the three statement syncs                               | full                     | Quarterly statements merged into point-in-time versions: a restatement adds a version (`is_latest` marks the newest), `known_at` is the SEC acceptance time, TTM figures as known then           |
| `universe_daily`    | `securities`, `prices_daily`, `historical_market_cap`, `fundamentals_pit` | `universe_daily` (`security_id`, `date`) and `universe_counts` (`date`) | after `transform:prices_daily`                                | date_range, lookback 30  | The research universe: for every security and priced date, `in_universe` when price, 20-day median dollar volume, market cap (that day) and exchange all pass; `fails` lists the failing filters |
| `features_daily`    | `securities`, `prices_daily`, `universe_daily`, `fundamentals_pit`        | `features_daily`                                                        | after `transform:universe_daily`                              | date_range, lookback 260 | Momentum, 12-1, volatility, 52-week high, valuation, quality and growth from the fundamentals known that day, priced at that day's market cap                                                    |
| `features_ranked`   | `features_daily`, `universe_counts`                                       | `features_ranked`                                                       | after `transform:features_daily`                              | date_range               | Per date, over that date's universe: z-scores (clipped at ±3), percentiles, composite scores with sector percentiles                                                                             |
| `macro_daily`       | `treasury_rates`, `eod_index`, `sector_performance`                       | `macro_daily` (`date`)                                                  | after `dataset:treasury_rates`, `dataset:eod_index`           | full                     | Treasury curve (3m, 2y, 10y, 30y, spreads), VIX, S&P 500 and Nasdaq levels with the S&P daily return, sector returns                                                                             |

**universe_daily and the S&P 500 proxy.** Its parameters are the filters:

```yaml
params:
  min_price: 5
  min_adv_20d: 1000000 # USD, median dollar volume over 20 trading days
  min_market_cap: 300000000 # USD, as of that date
  exchanges: [NASDAQ, NYSE, AMEX, NYSE American]
```

A threshold of 0 turns that filter off. `market_cap` on each row is the reported value from
`historical_market_cap` when there is one, else close × shares outstanding as known that day from
`fundamentals_pit`; `market_cap_source` says which (`reported` or `estimated`). The S&P 500 proxy ranks
`in_universe` members by this field on each rebalance date. Never filter by today's market cap: that is
lookahead.

> **On live:** reported market caps (`historical_market_cap`) start on 2026-07-23, about 77 rows per symbol. For the
> research window (2022–2025), `universe_daily.market_cap` is therefore the **estimate**:
> `market_cap_source: "estimated"`, close × basic shares outstanding from the latest filing known on that date
> (`fundamentals_pit`). That is a sound way to rank the 500 largest names, but it is approximate: basic rather
> than diluted shares, updated quarterly.

#### How to: add a Layer 2 transform that runs after prices_daily

Example: a 252-day drawdown per security.

1. Datasets → **Transforms** → **New transform** → **Feature** (closest template).
2. **Basics → Name**: `drawdown_daily`. **Description**: "Drawdown from the 252-day high of the adjusted close."
3. **Inputs**: remove `eod_prices` (×), **+ Add input…** → `prices_daily`.
4. **Outputs**: collection `drawdown_daily`, **Key** `security_id, date`, **Write mode** `upsert`, **known_at
   field** `known_at`, **as_of field** `as_of_date`, **Grain** `security × trading day`.
5. **Trigger → Run after**: `transform:prices_daily`.
6. **Incremental**: **Mode** `date_range`, **Lookback (trading days)** `260`.
7. **Code**:

   ```python
   import oh

   w = oh.window
   flt = {"date": {"$gte": w.lookback_start, "$lte": w.end}} if w else {}
   df = oh.read_df("prices_daily", flt,
                   columns=["security_id", "date", "adj_close", "known_at", "as_of_date"])
   df = df.sort_values(["security_id", "date"])
   peak = df.groupby("security_id")["adj_close"].transform(lambda s: s.rolling(252, min_periods=20).max())
   df["drawdown_252d"] = df["adj_close"] / peak - 1
   if w:
       df = df[df.date >= w.start]          # the lookback is context; write only the window
   oh.output("drawdown_daily").upsert_df(df[["security_id", "date", "drawdown_252d", "known_at", "as_of_date"]])
   oh.describe("drawdown_daily", fields={"drawdown_252d": {"description": "adj_close / 252-day high - 1", "unit": "ratio"}})
   ```

   The rows inherit `known_at` and `as_of_date` from `prices_daily`, which is right: the drawdown on date D is
   known at D's close.

8. **Preview**. Check the bar: rows, "Key is unique", "known_at present on every row", "New collection (no
   earlier schema)". Look at **Rows**.
9. **Create**. From now on it runs after every `prices_daily` run, for the same window.
10. To fill history: **Run now** → **Full backfill (yearly chunks, in order)**, **Start** `2016-01-01` →
    **Queue run**. Start with a **Custom range** of a month to check the timing first.

The same transform as YAML (import from **Import** on the Transforms tab or Settings → Configuration (YAML)):

```yaml
apiVersion: stockharness/v1
kind: Transform
metadata:
  name: drawdown_daily
spec:
  description: Drawdown from the 252-day high of the adjusted close.
  code: |
    import oh
    ...
  inputs: [prices_daily]
  outputs:
    - collection: drawdown_daily
      key: [security_id, date]
      write_mode: upsert
      known_at_field: known_at
      as_of_field: as_of_date
      grain: security × trading day
  trigger:
    after: [transform:prices_daily]
  incremental: { mode: date_range, lookback_days: 260 }
  params: {}
  secrets: []
  enabled: true
```

#### How to: find out why a transform did not run

1. Open the transform. **Trigger** section: the pills show which upstreams are "done" and which are "waiting".
   It runs only when all are done (or 24 hours after the first one).
2. A "waiting" `dataset:` upstream: open that sync. Is it enabled, is its schedule on, did its last run succeed?
   A failed sync emits no completion event.
3. Is **Enabled (scheduled and triggered runs)** ticked?
4. **Run history**: a failed run shows its error; open it for stderr. The code editor marks the traceback line.
5. **Datasets → Health → Failing** lists the latest failed run of every transform.

#### How to: go back to an earlier version

**Versions** → pick versions in **Compare … with …** to diff **Code** or **Settings** → **Restore** on the
version you want. It is saved as a new version; the next run uses it.

### Python secrets

**Where:** Settings → **Python secrets**. "API keys and passwords that Python code needs, for example
`FMP_API_KEY`." A secret has a **Name** (upper-case letters, digits and `_`) and a **Source**: **Copy from an MCP
connection** (pick the **MCP connection** and the **URL parameter**, e.g. `apikey`, copied server-side) or
**Enter a value**. **Save secret**. Values are encrypted and never shown again.

A transform lists the secret names it needs in **Params and secrets → Secrets**; the job gets exactly those as
environment variables (`os.environ["FMP_API_KEY"]`). A listed secret that does not exist fails the run before it
starts. None of this deployment's transforms uses a secret: they read only MongoDB. You would need one only for
a transform that calls an outside API itself.

---

## Pipelines tab

**What it is for.** "Pipelines run the layers as one DAG per period: a step starts only when its upstream steps
finished and passed their completeness gates." Where a transform's **Run after** is a simple chain, a pipeline
adds **periods** (one run per day, ISO week or month), **gates** (minimum coverage, rows, row-drop, DQ rate),
other layers (harnesses, research, live) and full run tracking with retry and skip.

**How to get there.** Datasets → **Pipelines** (`/datasets/pipelines`).

**In this deployment** there are no pipelines, on the live stack or in the exported configuration
(`deploy/config-io/exports/pipelines.yaml` is empty). The Layer 2 chain runs on transform triggers. The empty state
says "No pipelines yet. Create one, or generate it from your transforms' dependencies."

### The list

**KPI cards:** **Pipelines**, **Runs today**, **Blocked**, **Failed**. **Columns:** **Name**, **Schedule**,
**Period**, **Last run**, **Duration**, **Nodes passed**, **Next run**. Header: **Export** / **Import** and
**New pipeline**.

### The pipeline page

**Header:** name and version, "<schedule> · per <period> · next …", **Export** / **Import**, **Backfill**
(not for event pipelines), **Run now**, and **Delete pipeline** ("Its run history is kept").

**Run strip:** one cell per recent run (its period id, coloured by status; hover for "2026-W45 · succeeded ·
backfill"). Click a cell to show that run. The summary reads "<status> <start> → <end> · N / M passed ·
<duration>", with "deadline missed" and **Cancel run** when it applies.

**Tabs:**

| Tab          | What it shows                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Graph**    | The DAG in swimlanes: **L1 · Syncs**, **L2 · Transforms & checks**, **L3 · Research**, **L5 · Live**, **Harnesses**. Each node card: id, status pill ("waiting on upstream", "gate failed" …), its ref, duration, rows, and the first gate with ✓ or ✗. The critical path is highlighted; selecting a node highlights its upstream and downstream |
| **Timeline** | A Gantt chart of the selected run: one bar per node with its status                                                                                                                                                                                                                                                                               |
| **Edit**     | The editor (administrators)                                                                                                                                                                                                                                                                                                                       |

**Node drawer** (click a node): status and attempts ("re-run 2×"), started and finished times, the error, skip
reason or warning, **Gate** (each check with value, threshold and pass/fail, or "No gate: succeeding is
enough."), **Stats** (rows, symbols attempted and covered …), **Underlying …** (the run ids), and the controls
**Retry** (failed, gate failed, blocked or cancelled nodes), **Re-run from here** (this node and everything
downstream; upstream results are kept) and **Mark skipped…** (asks "Why skip this node? Downstream nodes treat it
as done."). For a transform or sync node the drawer can open it full page.

### The editor

**Add node**, **Generate from dependencies** ("Nodes and edges from the transforms' inputs and run-after
triggers"; it asks before replacing the nodes), and **Create** / **Save version**. "Drag from a node's right edge
to another node to add an edge; select an edge and press Delete to remove it." Errors (block saving) and warnings
show as pills.

**Pipeline settings:** **Name** ("Lowercase, digits, dashes, underscores"), **Period** (`day`, `week (ISO)`,
`month`, `event (manual)`; "A run covers the period containing the day before it starts"), **Description**, the
schedule, **Deadline (hours)** ("Alert when a run is not done by then"), **Enabled (scheduled runs)**.

**Node fields:**

| Field                                  | What it does                                                       | Example                                       |
| -------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| **Id**                                 | Short id used in edges                                             | `prices`                                      |
| **Type**                               | `sync`, `transform`, `check`, `harness`, `research`, `live`        | `transform`                                   |
| **Object**                             | The sync, transform or harness by name                             | `prices_daily` → ref `transform:prices_daily` |
| **Collection**, **Date field** (check) | For `check:collection_rows`: rows of that collection in the period | `prices_daily`, `date`                        |
| **After**                              | Upstream nodes (ticks)                                             | `eod`                                         |
| **Min symbol coverage %** (syncs)      | Gate on symbols covered / attempted                                | `95`                                          |
| **Min rows**                           | Gate on rows                                                       | `1000`                                        |
| **Max row drop %**                     | Gate versus the previous period                                    | `50`                                          |
| **Max DQ issues per row** (transforms) | Gate on the DQ rate                                                |                                               |
| **If an upstream fails**               | `block` (default), `skip`, `continue with a warning`               | block                                         |
| **Retries**                            | Default 1 (backoff 1, 5, 15 minutes)                               | 1                                             |
| **Timeout (minutes)**                  | Default 360                                                        |                                               |

"Saving creates v<N+1>. Runs in progress keep the graph they started with."

A sync node runs the sync's own incremental window; a transform node gets the run's period as its window.

### Pipeline backfill

**Backfill** opens "Backfill <name>": "Runs past <period>s oldest first, without touching the schedule. Periods
that already have a run are skipped." Fields: **From period**, **To period** (e.g. `2026-10-01` for day,
`2026-W40` for week, `2026-06` for month) and **Parallelism** ("Periods run at the same time (1–4)").

#### How to: build a weekly pipeline for the price chain

1. **Pipelines** → **New pipeline**. **Name** `weekly-prices`, **Period** `week (ISO)`, schedule weekly Saturday
   06:00 America/New_York.
2. **Add node** `eod`: Type `sync`, Object `EOD prices (5y, universe)`, **Min symbol coverage %** `95`.
3. **Add node** `ca`: Type `transform`, Object `corporate_actions`.
4. **Add node** `prices`: Type `transform`, Object `prices_daily`, **After** `eod`, `ca`, **Min rows** `1000`.
5. **Add node** `universe`: Type `transform`, Object `universe_daily`, **After** `prices`.
6. **Create**, then **Run now** and watch the **Graph**. A gate that fails turns the node "gate failed" and
   blocks what follows; open the drawer to see the value against the threshold.

Or start with **Generate from dependencies** and delete the nodes you do not want. Note that transforms keep
their own **Run after** triggers too; a pipeline does not switch them off.

---

## Health tab

**What it is for.** One screen that answers: is the data fresh and complete, and what needs attention?

**How to get there.** Datasets → **Health** (`/datasets/health`), or click the data-freshness pill in the top bar.
It refreshes every minute; **Refresh** reloads now.

### What you see

**Banner** (also the top-bar pill, which polls every 5 minutes):

| Level | Text                                                                              | When                                                                                                  |
| ----- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| red   | "Layer 2 blocked at <pipeline> › <node>" or "Layer 2 blocked: <transform> failed" | A pipeline's latest run has a blocked, gate-failed or failed node, or a transform's latest run failed |
| amber | "N syncs late" or "N collections stale"                                           | A sync is late, or a collection is stale                                                              |
| green | "Data fresh as of 2026-11-07 close"                                               | Otherwise (the date is the latest date in `prices_daily`, else `eod_prices`)                          |

**KPI cards:** **Fresh** ("of N collections"), **Stale** ("N syncs late"), **Failed** ("collections and
transforms"), **Drift alerts** ("schema changes in synced data").

**Drift alerts** (when any): **Collection** (and the sync), **Field**, **Change** (`missing field`, `added
field`, `type change`, `null rate`; "Breaking: those items were not written"), **Seen** ("3× · <time>"),
**Resolve** (administrators).

**Failing:** every sync whose last run failed (with its error) and every transform whose latest run failed (links
to the editor).

**Pipelines:** each pipeline's latest run, with "blocked" and where it stopped.

**The collections table.** **Needs attention** (default) shows only collections that are not fresh, have DQ
errors, blocking caveats or gaps; **All collections** shows every one.

| Column         | What it shows                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Collection** | Name (links to the Catalog) and its producer                                                                                                                 |
| **Layer**      | L1 or L2                                                                                                                                                     |
| **Freshness**  | `fresh`, `stale`, `failed`, `pending` (never updated); "N sessions behind"                                                                                   |
| **Latest**     | The latest date in the data, and "updated <time>"                                                                                                            |
| **Coverage**   | Share of the sync universe, and rows                                                                                                                         |
| **Gaps**       | A strip of the last 60 expected NYSE sessions: hollow cells had no rows. **Compute gaps** builds it when the collection's coverage has not been computed yet |
| **Issues**     | Open DQ errors and warnings (from `dq_issues`), blocking caveats, the last error                                                                             |

### How freshness is decided

1. **failed** when the producer's last run failed; **unknown** (`pending`) when it never updated.
2. Otherwise **stale** when the last update is older than the allowance for its cadence:

   | Cadence (from the producer's schedule)    | Stale after                                         |
   | ----------------------------------------- | --------------------------------------------------- |
   | Minutes or hours                          | 1 day                                               |
   | Daily, or a transform that runs "after …" | 3 days                                              |
   | Weekly (any weekday)                      | 10 days                                             |
   | Every N days                              | 2N + 1 days (`trading_calendar`, every 30 days: 61) |
   | Monthly                                   | 40 days                                             |
   | No schedule                               | 8 days                                              |

3. A daily, dated collection that is "fresh" by time becomes **stale** when its data lags more than 3 expected
   sessions (its latest date is more than three NYSE sessions behind; today does not count).

A sync is **late** when it is enabled and its next run is more than an hour in the past, which means the
dispatcher should have started it.

### What to do

| You see                                    | Likely cause                                                | What to do                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Amber "N syncs late"                       | The API was down or busy, or a long sync queue              | Open **Syncs**, sort out the late ones; **Run now**. Check FMP calls today                                                     |
| A sync under **Failing**                   | FMP error, plan limit, no universe, bad key                 | Open the sync → error and **Runs** ([plan limits](#plan-limits-failures-and-the-pause))                                        |
| `eod_prices` stale, "4 sessions behind"    | The daily price sync stopped or is paused                   | Fix the sync; then **Run now** (it pulls from its cursor, so the gap fills itself)                                             |
| Red "Layer 2 blocked: prices_daily failed" | A transform error                                           | Open the transform → **Run history** → stderr; fix, **Save version**, **Run now** with a custom range covering the missed days |
| Hollow cells in the gap strip on weekdays  | Missing days                                                | Holidays are not expected sessions (with `trading_calendar`). Real gaps: run a sync backfill for that range                    |
| A drift alert, breaking                    | FMP changed a key or date field                             | Items were not written. Check the **Sample**, adapt the transform if needed, then **Resolve**                                  |
| A drift alert, not breaking                | A new or missing optional field                             | Check that transforms do not depend on it, then **Resolve**                                                                    |
| DQ errors on `prices_daily`                | Zero or negative prices, high below low, implausible prices | Open the transform run's DQ issues. They do not fail runs; pipeline gates can                                                  |
| `analyst_estimates` with a blocking caveat | Snapshot data has no history                                | Expected. Ideas using it are forward-only                                                                                      |

---

## Questions and answers

**Can a strategy use a Layer 1 collection directly?** Yes, if its Catalog time rule is point in time. Current-only
and undocumented collections are refused for historical dates.

**Why does the Rows column of a sync show a small number when the collection has millions?** It is the rows
written by the last run. A daily price run writes about one row per symbol.

**What does Reset cursor do to my data?** Nothing. The next run of a time-series sync pulls again from **From**,
upserting over what is there.

**What is the difference between Purge records and Delete?** Purge empties the collection and keeps the sync
(which then re-pulls history). Delete removes the sync and keeps the collection, unless you tick "Also drop these
collections".

**Does an import overwrite my data?** No. Imports change sync configurations only. Collections are never touched.

**Why do two dataset syncs with different names write the same collection?** Both chose the same target, for
example `EOD AAPL/MSFT` and `EOD prices (5y, universe)` both write `eod_prices`. That is allowed; their rows merge
on the key (`symbol`, `date`). Purging one resets the cursor of both.

---

---

# Part 3: Research, ideas and evaluations (Layers 3 and 4)

This part covers the research side of StockHarness:

- **Layer 4, the research loop.** AI agents propose trading ideas, review them, write code for them and judge
  the results.
- **Layer 3, the trusted evaluator.** Fixed platform code backtests each idea's code, point in time and after
  costs, and writes a record that is the same every time it is re-run.

It walks through the **Research** page (Lab, Setup, How it works, Cycles), how the loop works, the gates and
verdicts, the **Ideas** pages, the **Evaluations** page with "Results by name" and "Names it works for", and the
strategy plugin contract.

Examples use this deployment's setup:

- **Models:** two chat models. `Gemini-flash-3-8` runs model `gemini-3.8-flash`. `Gemini-4-pro` runs model
  `gemini-4-argon`.
- **Budget:** $150 overall and $90 a day.
- **Evaluation window:** 2022-05-03 → 2025-05-03, before an 18-month locked holdout.

A few terms used throughout:

| Term              | Meaning                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Theory / idea** | One testable trading hypothesis, numbered `T-<n>` (T-5, T-12…). The research loop calls it a theory and the Ideas pages call it an idea. They are the same record. |
| **Plugin**        | The short Python module the Coder writes for a theory. It scores stocks on each rebalance date. Every saved change is a new version (v1, v2…).                     |
| **Evaluation**    | One run of the trusted evaluator on one plugin version over a date window. It produces a structured **record**: numbers and series, never free text.               |
| **Trial**         | Every evaluation counts as one trial in the workspace's global count. More trials make the "deflated Sharpe" stricter.                                             |
| **Exploration**   | An evaluation over the research window, which always ends before the holdout.                                                                                      |
| **Holdout**       | The last 18 months of price history. It is locked away from exploration and run once per theory at the verdict.                                                    |
| **Gates**         | Fixed thresholds (Sharpe ≥ 0.5 and so on) that decide the verdict mechanically.                                                                                    |
| **Cycle**         | One run of the research loop harness: Theorists → Judge (pre-code) → Coder → Judge (post-result).                                                                  |
| **Point in time** | On every date, a strategy sees only data that was known by that date.                                                                                              |

---

## Research page

**Purpose.** This page runs the research loop and lets you watch it: what the agents are doing now, what it
costs, and how to configure and steer it.

**How to get there.** Click **Research** in the sidebar (flask icon). Each tab has its own URL:

| Tab          | URL                                                               |
| ------------ | ----------------------------------------------------------------- |
| Lab          | `/research`                                                       |
| Setup        | `/research/setup`                                                 |
| How it works | `/research/how`                                                   |
| Cycles       | `/research/cycles`, and `/research/cycles/<run id>` for one cycle |

**What you see.** The title **Research** with the line "Agents propose, review, code and judge trading ideas;
every step is a record you can open." Below it are four tabs: **Lab**, **Setup**, **How it works** and
**Cycles**.

Only administrators can change things: start, pause, save settings, steer, or run a cycle. Other users see the
same pages read-only.

### Lab tab

The research loop at a glance. The page refreshes every 15 seconds, and the activity feed is live.

**Header row**

| Control                | What it does                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status pill            | `paused`, `last cycle <status>` (for example `last cycle succeeded`) or `no cycle yet`.                                                                                                                             |
| `every N min`          | Shown when the loop runs on a schedule.                                                                                                                                                                             |
| **All ideas**          | Opens `/ideas`.                                                                                                                                                                                                     |
| **Pause** / **Resume** | (Admin) Pausing turns off the schedule. The brief tells agents of a running cycle to stop ("The research loop is paused: do nothing and reply DONE."). Resuming turns the schedule back on if Setup has it enabled. |
| **Settings**           | (Admin) Opens the Setup tab.                                                                                                                                                                                        |

**Notices**

- "No research loop yet. Open Settings and install it (the role connections and seed skills are created for
  you)." This appears before the loop harness exists.
- A red **spend cap** notice: "The loop paused itself on <date>: <reason>. Raise the cap in Settings, then
  Resume." See [Budget](#budget).
- A **budget** notice when today's tokens pass the optional daily token alert. The alert is set through the API
  or YAML only, not in Setup (`budget.dailyTokenAlert`).

**KPI cards**

| Card               | What it counts                                                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Theories today** | Theories created since 00:00 UTC.                                                                                                                                                                                                                                       |
| **In flight**      | Theories on the board in any state except Draft: revising, pre-review, approved for code, coding, code error, revising code, evaluated, post-review.                                                                                                                    |
| **Successful**     | Successful plus approved ideas, as a share of all decided ideas. The footnote reads "of N verdicts". Decided means successful, promising, failed, approved or parked. Rejected-as-untestable ideas are left out. Promising ideas count as decided but not as successes. |
| **Total trials**   | The workspace's global trial count ("every evaluation counts").                                                                                                                                                                                                         |
| **Spend today**    | Dollars spent on model calls today (UTC day), priced per model. The footnote shows tokens today, the daily cap if one is set, and "$X of $Y since <date>" for the overall cap, or "no spend cap".                                                                       |

Example footnote with this deployment's budget: `412,880 tokens · daily cap $90 · $37.40 of $150 since 11/6/2026`.

**Pipeline board.** One column per stage of the lifecycle, plus today's verdicts:

| Column           | Theory statuses in it                                                            |
| ---------------- | -------------------------------------------------------------------------------- |
| Draft            | draft, revise ("Revising")                                                       |
| Pre-review       | pre_review                                                                       |
| Coding           | approved_for_code, coding, code_error, revise_code                               |
| Evaluating       | evaluated                                                                        |
| Post-review      | post_review                                                                      |
| Today's verdicts | successful, promising, failed, rejected, approved or parked, updated today (UTC) |

Each card shows `T-n title`, the status pill, the family (for example `momentum`), `· forward only` when it
applies, and a line like `1 rev · 2 code retries · 1 trials`. Click a card to open the idea at `/ideas/T-n`.

**Live activity.** The ideas' debate as it happens. It shows the last 3 days, newest first, up to 200 entries. Each
entry has:

- the time;
- the theory id, which links to the idea;
- the role (theorist, judge, coder, evaluator, human);
- the move (for example `pre_review → approved_for_code`) or the event type (`create`, `edit`, `link`,
  `comment`);
- the model that made the decision (for example `· gemini-3.8-flash`);
- the reasoning, up to 600 characters.

The server pushes new events about every 3 seconds (Server-Sent Events).

**Steer the Theorists.** This box sends a note to the Theorists: "The next cycle's Theorists read the latest
notes in their brief."

- The text area is labelled "Steering note", with the placeholder "e.g. Focus on quality and low-volatility
  ideas; avoid pure momentum this week."
- **Send to the Theorists** needs at least 3 characters (admin only).
- The workspace keeps the latest 5 notes. Each brief shows the latest **3**.

**Charts** (the last 30 days)

| Chart                    | What it shows                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Verdicts per day         | Bars for successful, promising, failed and rejected verdicts.                         |
| Success rate             | successful ÷ (successful + failed) per day. Promising verdicts are not in this ratio. |
| Cumulative trials        | The running count of evaluations stored in the workspace.                             |
| Tokens by role (30 days) | Input and output tokens for theorist, judge, coder and other.                         |

### Setup tab

This tab sets up and starts an experiment in one place. It has a status card at the top, then the sections
**Scope**, **Agents**, **Idea profiles**, **Budget**, **Schedule** and **Success gates**, and a **Save** button
at the bottom.

Nothing you edit takes effect until you click **Save**. The exception is **Start**, which saves for you. After
**Save** the page says "Saved.", or "Saved. Gates vN is now active; verdicts under vM stay as they were." if you
changed a gate.

When the loop already exists, saving rebuilds the harness, so a change of model, skills, Theorists, effort,
turns or schedule applies from the next cycle.

#### Status card and the Start / Pause / Run buttons

The bold state is **Paused**, **Running on a schedule** or **Not scheduled**. The line under it shows the harness
name, `every N min` or `no schedule`, `until <date>`, and the last cycle's status and time. If the loop is not
installed yet, it reads "The research loop is not installed yet: Start installs it."

A spend line follows: "Spend today $12.31 of $90 a day · $37.40 of $150 since the cap started". If a cap stopped
the loop, the reason appears with a **spend cap** pill.

| Button              | What it does                                                                                                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Start**           | Turns the schedule on (every 60 minutes if none was set), saves the settings, installs the loop if needed, and resumes it if it was paused. Message: "Started: cycles run on the schedule." Installing creates the three role connections (`Research — Theorist`, `Research — Judge`, `Research — Coder`) and attaches the seed skills. |
| **Pause / Resume**  | The same as on the Lab tab. Disabled until the loop is installed.                                                                                                                                                                                                                                                                       |
| **Run a cycle now** | Starts one cycle at once, whatever the schedule ("A cycle started; follow it in Lab or Cycles."). It is refused while paused, before installation, and while another cycle is queued or running ("one at a time"). The scheduler also skips a slot while a cycle is still running.                                                      |

#### Scope

The scope is the set of stocks every evaluation ranks. The on-screen note says: "The FMP plan has no S&P 500
constituents list, so the S&P 500 proxy is the 500 largest US stocks by market cap on each date (point in time,
delisted names included)."

| Field                                     | What it does                                                                                                                                                                       | Example                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **S&P 500 proxy (top 500)**               | On each rebalance date, the 500 largest names in `universe_daily` by that day's market cap. Names that later delisted are included, so there is no survivorship bias.              | The default choice for real runs.            |
| **Top N by market cap**                   | The same rule with your own N. Shows the field **N (largest by market cap)**, from 10 to 5,000. Switching to it starts at 1,000.                                                   | `1000` for a broader large-and-mid-cap test. |
| **A symbol list**                         | A fixed list of tickers. Shows **Symbols (n)**, a text area where tickers are separated by spaces or commas. The default list is 50 large caps (AAPL MSFT NVDA AMZN GOOGL META …). | `AAPL MSFT NVDA JPM XOM` for a quick test.   |
| **Evaluation years (before the holdout)** | How many years before the holdout the Coder evaluates over, from 1 to 15 (default 3). The window ends the day before the holdout starts and begins this many years earlier.        | `3` gives 2022-05-03 → 2025-05-03 here.      |

How the window is set:

- **The holdout.** At first use, the workspace fixes the holdout start to 18 months before the latest
  `prices_daily` date. The start then stays fixed, so data never drifts out of the holdout as new days arrive.
- **The research window.** The window ends the day before the holdout starts and goes back **Evaluation years**
  from there. In this deployment that is 2022-05-03 → 2025-05-03, with the holdout from the next day to the
  latest price date.

How the scope is applied:

- **Every evaluation uses it.** The Coder may choose the dates (within the window), the side, `top_n`, the
  rebalance frequency and plugin parameters. The server always replaces the names with the research scope, so an
  agent cannot quietly test on a friendlier set of stocks.
- **Large scopes lose some analysis.** The sector benchmark and the factor regression are computed only when the
  eligible universe has at most 600 names. The S&P 500 proxy qualifies. Top 1,000 does not: its records have no
  sector excess, and the factor regression uses the market only, which makes the alpha t gate easier to pass.

#### Agents

A table with one row per role. The **Role** column describes each one:

- **Theorist**: proposes theories (one per Theorist per cycle).
- **Judge**: reviews them before code, and judges the results.
- **Coder**: writes and tests the strategy code, then evaluates it.

| Field                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                        | Example                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Model** (one select per role)                 | The chat model for that role, listed as `<provider name> · <model>`. **Default (first chat model)** uses the role's saved model, else the Theorist's, else the first chat model in the workspace. The Judge's model is used for both Judge steps.                                                                                                                                                   | Theorist and Judge `Gemini-flash-3-8 · gemini-3.8-flash`, Coder `Gemini-4-pro · gemini-4-argon` |
| **Skills it loads**                             | Chips for every skill in the workspace. Tick to choose. A **dashed** chip is "Loaded by default (no choice saved)". The defaults are: Theorist `strategy-library` and `read-the-catalog`; Judge `judge-checklist`, `read-the-catalog` and `strategy-library`; Coder `write-a-strategy-plugin` and `read-the-catalog`. Once you tick anything for a role, your choice replaces that role's defaults. | Add a custom `quality-factors` skill to the Theorist.                                           |
| **Theorists per cycle**                         | How many Theorists propose in parallel each cycle, from 1 to 8 (default 2). Each proposes at most one theory per cycle.                                                                                                                                                                                                                                                                             | `2`                                                                                             |
| **Pause Theorists at (ideas waiting for code)** | The backlog brake: when this many ideas wait for the Coder, Theorists stop proposing new ones. Revisions still go through. Range 1 to 200, default 8. See [The backlog brake](#the-backlog-brake).                                                                                                                                                                                                  | `8`                                                                                             |
| **Effort**                                      | The reasoning effort for every research agent: `light`, `medium`, `high` (default), `extra-high` or `max`.                                                                                                                                                                                                                                                                                          | `high` for real runs, `medium` for a smoke test.                                                |
| **Turns per agent**                             | The most model turns each agent may take in a cycle, from 3 to 200 (default 30).                                                                                                                                                                                                                                                                                                                    | `30`, or `12` for a smoke test.                                                                 |
| **Focus for the Theorists**                     | Free text shown in every brief. Empty means "none set: any family from the strategy-library skill".                                                                                                                                                                                                                                                                                                 | "Quality and low-volatility ideas on large caps; holding periods of 1 to 3 months."             |

The research agents have no token budget of their own. They are bounded by their turns, the per-theory caps the
tools enforce, and the spend caps below.

#### Idea profiles

A profile says what an idea trades and how. The on-screen note: "What the Theorists propose, in order:
Theorist 1 takes the first ticked profile, Theorist 2 the second, and so on (counting again from the first).
None ticked: equity long, short and long / short."

| Group                 | Profiles                                                                                                    | Available            |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------- |
| Equity                | Long, Short, Long / short                                                                                   | Yes                  |
| Options · income      | Covered call, Cash-secured put, The wheel (put, then covered call)                                          | No, shown greyed out |
| Options · directional | Long call, Long put, Bull call spread, Bear put spread, Bull put (credit) spread, Bear call (credit) spread | No                   |
| Options · hedge       | Protective put, Collar                                                                                      | No                   |
| Options · volatility  | Long straddle, Long strangle, Short strangle, Iron condor                                                   | No                   |

- **Order matters.** Each ticked profile gets a badge **Theorist 1**, **Theorist 2**…, in the order you ticked
  them.
- **Options are not available yet.** The page says "Options profiles open when the options evaluator is ready
  (#329)." Until then, the server refuses an options theory: "Options ideas cannot be tested yet: the options
  evaluator is coming (#329). Propose an equity idea (instrument: equity) this cycle."

Example: with 2 Theorists, tick **Long / short** first and **Long** second. Theorist 1 then proposes market-neutral
ideas and Theorist 2 long-only ideas. With 3 Theorists and those two ticks, Theorist 3 starts again from Long / short.

#### Budget

The on-screen note: "Model calls are priced per model. At any cap the next call is refused and the loop pauses
itself; a model's own cap stops only that model."

| Field                           | What it does                                                                                                                                                                                                                                   | Example                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **Total cap (USD)**             | Hint: "Counted from when it is first set". Typing a value records the start time. Changing the number later keeps that start. Clearing the field removes the cap and its start, so typing a new value starts counting from scratch.            | `150`                    |
| **Daily cap (USD)**             | Hint: "The UTC day". The cap on spend since 00:00 UTC.                                                                                                                                                                                         | `90`                     |
| **Spend by model** table        | One row per model that has spent anything or that a research role uses. Columns: **Model**, **Price in / out (per 1M)**, **Today**, **Since the cap started**, **Cap (USD)**, **Daily cap (USD)**. A **capped** pill marks a model at its cap. | see below                |
| **Cap (USD)** (per model)       | The model's own cap, counted from the same start as the total cap (from the beginning of recorded usage if no total cap is set). Only that model's calls are refused at the cap.                                                               | `60` on `gemini-4-argon` |
| **Daily cap (USD)** (per model) | The model's own cap per UTC day.                                                                                                                                                                                                               | `40` on `gemini-4-argon` |

**How it works**

- **Built-in prices** (USD per 1M tokens; output includes thinking):

  | Model              | Input | Output |
  | ------------------ | ----- | ------ |
  | `gemini-3.8-flash` | $0.75 | $3.75  |
  | `gemini-4-argon`   | $2.00 | $10.00 |

  A model missing from the table is priced at $3 / $15, so a cap errs on the safe side.

- **The built-in table does not update itself.** The code notes that `gemini-4-argon` goes to $4 / $20 from
  2026-12-01, and that Google's prices double on 2027-01-01. The table still says $2 / $10. You can override
  prices with `budget.prices` in the research settings (API or YAML). Setup has no field for it.
- **The check.** Before every model call in the workspace, research or not, the platform checks spend against
  the caps. An overall cap refuses every call: "Spend cap reached: … Raise the cap in Research → Setup to
  continue." A model's cap refuses only that model's calls.
- **Cached for 20 seconds.** The spend figure is re-read at most every 20 seconds, so calls already in flight can
  overshoot a cap slightly. A changed cap applies at the next call.
- **The first time a cap is hit,** the loop pauses itself: the schedule goes off, and the time and reason are
  recorded. Lab and Setup show the reason.
- **Worked cost example.** One Coder turn that reads 200,000 tokens and writes 8,000 costs:
  - on `gemini-4-argon`: 0.2 × $2 + 0.008 × $10 = **$0.48**;
  - on `gemini-3.8-flash`: 0.2 × $0.75 + 0.008 × $3.75 = **$0.18**.

  A $90 daily cap is therefore roughly 190 such Coder turns on Gemini 4.

**Two things to know**

- **A daily-cap pause does not end on its own the next day.** The loop stays paused until you press **Resume**
  (or **Start**).
- **Edit the budget before you resume.** **Resume** does not clear the recorded stop. While it stays recorded, the
  Lab keeps showing the spend-cap notice. Worse, if a cap is hit again, calls are refused but the loop does not
  pause itself a second time. Clear it by editing any budget field in Setup and clicking **Save**: editing the
  budget clears the stop record. Then resume.

#### Schedule

| Field                        | What it does                                                                                                        | Example            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **Run cycles on a schedule** | A toggle that turns scheduled cycles on or off.                                                                     | on                 |
| **Every (minutes)**          | Minutes between cycles, from 10 to 10,080 (one week). Default 60. A slot is skipped while a cycle is still running. | `60`               |
| **Until (optional)**         | Hint: "The schedule turns itself off after this". The date-time you enter is read as **UTC** and shown back in UTC. | `2026-11-17T18:00` |

#### Success gates

The heading reads **Success gates vN**, with a **locked** pill if a verdict has already used that version. The
note: "A theory is successful only when it passes every gate; changing a threshold creates gates vN+1, and
verdicts under different versions are not compared."

There is one number field per numeric gate, labelled with its key: `minSharpe`, `minDeflatedSharpe`,
`minPositiveExcessYears`, `minHoldoutExcess`, `minHoldoutSharpe`, `minTrades`, `minHoldings` and `minAlphaT`. The
list of blocking warnings is not editable here. What each gate means is in
[Gates and verdicts](#gates-and-verdicts).

#### How-to: Point research at the S&P 500 and start the loop

1. Open **Research → Setup**.
2. Under **Scope**, click **S&P 500 proxy (top 500)**. Keep **Evaluation years (before the holdout)** at `3`.
3. Under **Agents**, choose a model per role. For example, set Theorist and Judge to
   `Gemini-flash-3-8 · gemini-3.8-flash` and the Coder to `Gemini-4-pro · gemini-4-argon`. Set **Theorists per
   cycle** to `2`.
4. Under **Budget**, type `150` in **Total cap (USD)** and `90` in **Daily cap (USD)**.
5. Under **Schedule**, set **Every (minutes)** to `60`. Optionally set **Until** to the end of the experiment.
6. Click **Start**. The status card switches to "Running on a schedule · every 60 min".
7. Open the **Lab** tab to watch the board and the live activity. Open **Cycles** to see what each agent did.

#### How-to: Give the Coder Gemini 4 and cap its spend

1. **Research → Setup → Agents**: in the Coder row, choose `Gemini-4-pro · gemini-4-argon`.
2. Click **Save**. A row for `gemini-4-argon` now appears in **Spend by model**, even before it spends anything.
3. In that row, set **Cap (USD)** to `60` and **Daily cap (USD)** to `40`. Click **Save**.
4. When Gemini 4 reaches $40 in a UTC day, only its calls are refused, so the Coder step fails. The Theorists and
   the Judge on `gemini-3.8-flash` keep working, until the workspace hits its own $90 daily cap. The first cap
   reached also pauses the loop (see the notes above).

#### How-to: Steer the Theorists

You have three levers, from lightest to strongest:

1. **A steering note** (Lab → **Steer the Theorists**). Use it for "this week" guidance, for example "Avoid pure
   momentum; try earnings-revision ideas conditioned on low volatility." The next cycle's Theorists see the
   latest 3 notes and are told to follow them.
2. **The focus** (Setup → **Focus for the Theorists**). Use it for the standing research direction. It appears in
   every brief.
3. **Idea profiles** (Setup → **Idea profiles**). These fix what each Theorist proposes: long, short or long /
   short.

To redirect one specific idea, use **Send back…** on its idea page. See [Human actions](#human-actions).

#### How-to: Run a small smoke test (development)

Following the project's small-scale rule, a quick check should finish in about 2–3 minutes:

1. In Setup, set **Theorists per cycle** `1`, **Effort** `medium` and **Turns per agent** `12`.
2. Set **A symbol list** of about 10 tickers and **Evaluation years** `1`, and write a concrete **Focus**.
3. Turn **Run cycles on a schedule** off, then click **Save**.
4. Click **Run a cycle now** and follow it in **Cycles**.

### How it works tab

This tab shows the loop as the pipeline it is. The intro reads: "Each cycle runs the harness **Research loop**
once, left to right. The agents never talk to each other directly: they work on shared records (theories, code,
evaluations) through the research MCP tools, and each agent's connection only offers the tools of its role."

**The pipeline:**

```
Start → Theorists · in parallel [Theorist 1, Theorist 2, …] → Judge (pre-code) → Coder → Judge (post-result) → Finish
```

Each card shows the agent name, its model (or "default model") and "N skills · N tools". Click a card to see its
details:

| Section                                                    | Content                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Model**                                                  | Provider name and model, then "effort high · up to 30 turns". The Coder adds "· loops until its queue is empty". |
| **Reads** / **Writes**                                     | What the step reads and writes, in words (see the table below).                                                  |
| **Skills (N)**                                             | The skills it can load, with descriptions. Each one links to the Skills page.                                    |
| Connection (for example `Research — Coder`, `role: coder`) | "The tools this agent may call (N):", as chips.                                                                  |
| **Its instructions (system prompt)**                       | The full prompt, which you can expand.                                                                           |

**Tools per step** (enforced by the server from the connection's role)

| Step                | Tools                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Theorist            | `get_research_brief`, `search_theories`, `get_theory`, `submit_theory`, `list_collections`, `describe_collection`, `sample_collection`, `query_collection` |
| Judge (pre-code)    | `get_research_brief`, `search_theories`, `get_theory`, `review_theory`, `describe_collection`, `sample_collection`                                         |
| Coder               | `get_research_brief`, `get_theory`, `submit_code`, `evaluate_strategy`, `get_evaluation`, `describe_collection`, `sample_collection`, `query_collection`   |
| Judge (post-result) | `get_research_brief`, `get_theory`, `get_evaluation`, `set_verdict`                                                                                        |

**Reads and writes, in words**

| Step                | Reads                                                                                            | Writes                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Theorist            | the research brief (focus, steering notes, recent theories); the Schema Catalog and data samples | a new theory (draft → pre-review), or a revision the Judge asked for                                               |
| Judge (pre-code)    | theories in pre-review; the data they need                                                       | approve for code, send back to revise, or reject as untestable                                                     |
| Coder               | theories approved for code, sent back, or failing; the catalog, to check every field             | a strategy plugin (tested), then one evaluation of it → post-review                                                |
| Judge (post-result) | theories in post-review with their evaluations; the success gates                                | the verdict set by the gates: successful (after the one-shot holdout), promising, or failed; or send the code back |

Other limits: each agent has a 30-minute timeout. The Coder runs as a loop with up to 4 iterations and stops when
it replies `DONE`.

### Cycles tab

**The list** (`/research/cycles`) shows the newest 50 cycles. Columns:

| Column                                                           | What it shows                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Started**                                                      | When the cycle started.                                                                                                                                                                                                                                         |
| **Status**                                                       | The cycle's status, with the first 80 characters of any error.                                                                                                                                                                                                  |
| **Took**                                                         | Duration, in seconds under 90 s, else minutes.                                                                                                                                                                                                                  |
| **Cost**                                                         | Dollars, priced with the built-in table.                                                                                                                                                                                                                        |
| **Model calls**                                                  | Number of model calls.                                                                                                                                                                                                                                          |
| **Proposed**, **Reviewed**, **Coded**, **Evaluated**, **Judged** | Theory events in that cycle. Proposed counts theories created. Reviewed counts approve, revise or reject decisions. Coded counts moves into coding. Evaluated counts evaluations finished. Judged counts successful, promising, failed or revise-code verdicts. |

With no cycles yet, the tab reads "No cycles yet. Start the loop in Setup, or run one cycle now."

**One cycle** (click a row) shows:

- **The header.** The status, "took N min · cost $X", and any error.
- **Theories this cycle touched.** Each theory with its events in this cycle: role, move and the first 200
  characters of the reasoning.
- **What each agent did.** One expandable panel per agent: status, model, model calls, tokens, cost and the number
  of tool calls. Inside are **Loaded skills**, every tool call (expand it to see its **input** and **result**, with
  an **error** pill when it failed) and **Its final answer**.

All the Theorists of one cycle share a single row, "Theorists (in parallel: Theorist 1, Theorist 2)".

Use this view to debug a cycle that cost more than expected. Find the agent with the most model calls, then read
its tool calls. Usually an agent describes a collection several times, or retries a failing `submit_code`.

---

## How the research loop works

### The roles

| Role                         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Theorist** (1–8 per cycle) | Calls `get_research_brief`. Revises a theory sent back to it, if there is one; otherwise proposes **one** new theory. Theorist _i_ prefers the family at position _i_ of the strategy library and takes the _i_-th profile, so parallel Theorists differ. It checks `search_theories` for near-duplicates and `describe_collection` for each field it uses, then calls `submit_theory`. The theory must include the hypothesis, the signal logic in words, `data_needed` (`collection.field`), `horizon_days`, the direction, and a measurable falsification (what result would prove it wrong). |
| **Judge (pre-code)**         | For every theory in pre-review, runs the `judge-checklist` skill: testable, no lookahead, novel, plausible, data available. Then calls `review_theory` with **approve**, **revise** (saying exactly what to change) or **reject**, which marks it untestable.                                                                                                                                                                                                                                                                                                                                    |
| **Coder**                    | Works its queue one theory at a time, following each item's `next_step`. Writes the plugin, calls `submit_code` (which dry-runs it), and once the code passes calls `evaluate_strategy` **once**. It is told never to tune the code to the metrics.                                                                                                                                                                                                                                                                                                                                              |
| **Evaluator**                | Not an agent: the trusted evaluator, which is platform code. It runs the plugin, links the evaluation to the theory and moves the theory on: to post-review when the evaluation succeeds, or to code error when it fails.                                                                                                                                                                                                                                                                                                                                                                        |
| **Judge (post-result)**      | For every theory in post-review, calls `set_verdict` with **successful**, **failed** or **revise** (one concrete code change). The gates decide the outcome. See [Gates and verdicts](#gates-and-verdicts).                                                                                                                                                                                                                                                                                                                                                                                      |
| **Human**                    | You, on the Ideas pages: approve, park, reject, send back, comment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**The brief.** Every agent starts with `get_research_brief`, which returns:

- its role's queue;
- the focus;
- the idea profiles;
- the latest 3 steering notes;
- counts by status;
- the 20 most recent theories, so ideas stay novel;
- the Coder's real queue size and the backlog limit;
- the evaluation parameters, for example
  `{ start: "2022-05-03", end: "2025-05-03", universe: { top_by_market_cap: 500 } }`;
- the active gates.

A theory that was sent back carries its **feedback**: who sent it back and why.

**The Judge's two passes.** The Judge is one model with two passes per cycle. The pre-code pass comes before the
Coder and the post-result pass after it, so an idea approved in this cycle can be coded, evaluated and judged in
the same cycle.

### The theory lifecycle

```
draft → pre_review → (revise → pre_review)* → rejected_untestable | approved_for_code
approved_for_code → coding → (code_error → coding)* → evaluated → post_review → (revise_code → coding)*
post_review → failed | promising | successful → (human) approved | parked
```

| Status (on-screen label)                | Meaning                                                             | Who moves it on                                                       |
| --------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `draft` (Draft)                         | Created, not yet submitted.                                         | Theorist or human → pre_review                                        |
| `pre_review` (Pre-review)               | Waiting for the Judge's pre-code review.                            | Judge → revise / rejected_untestable / approved_for_code              |
| `revise` (Revising)                     | Sent back to the Theorist, by the Judge or by a person.             | Theorist or human → pre_review                                        |
| `rejected_untestable` (Rejected)        | The Judge found it untestable. Final for the agents.                | Human → revise                                                        |
| `approved_for_code` (Approved for code) | In the Coder's queue.                                               | Coder → coding                                                        |
| `coding` (Coding)                       | The Coder is writing or testing code, or its evaluation is running. | Coder or evaluator → code_error / evaluated                           |
| `code_error` (Code error)               | The last code failed its test, or the evaluation failed.            | Coder → coding (retry); at the cap → post_review                      |
| `evaluated` (Evaluated)                 | The evaluation finished. This status passes at once.                | Evaluator → post_review                                               |
| `post_review` (Post-review)             | Waiting for the verdict.                                            | Judge → revise_code / failed / promising / successful; human → revise |
| `revise_code` (Revising code)           | The Judge asked for one code change.                                | Coder → coding                                                        |
| `failed` (Failed)                       | Did not pass the gates. Kept, never hidden.                         | Human → revise                                                        |
| `promising` (Promising)                 | Beat the S&P 500 and failed only the proof gates.                   | Human → parked / failed / revise                                      |
| `successful` (Successful)               | Passed every gate, the holdout included.                            | Human → approved / parked / failed / revise                           |
| `approved` (Approved)                   | A person approved it.                                               | Human → parked / failed / revise                                      |
| `parked` (Parked)                       | Set aside by a person.                                              | Human → revise                                                        |

**Rules enforced on every move**

- **Roles.** Only the listed role can make each move. A Theorist cannot approve its own idea, and only a human
  approves or parks.
- **Reasons.** Every decision needs reasoning, except moves by the evaluator.
- **Atomic moves.** A move applies only if the theory is still in the state that was read: "T-7 moved meanwhile
  (it was coding); read it again." Two agents can never both move the same theory.
- **Content edits.** The idea's text can change only in `draft` or `revise`.
- **The full history.** Every move, edit, link and comment is stored with its actor (role, agent, model, run) and
  reasoning. That history is the debate on the Review tab.

### Caps: revisions and code attempts

| Cap           | Default | What counts                                                                                                                         | At the cap                                                                                                                                                                                                         |
| ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Revisions     | 3       | Every move to `revise` (Judge pre-code) or `revise_code` (Judge post-result), counted together.                                     | The Judge cannot send it back again: "This theory has used all 3 revisions; decide instead (…)". It must approve or reject before code, or give a verdict after.                                                   |
| Code attempts | 5       | Each retry from `code_error` back to `coding`. The count restarts at 0 on a fresh coding round (after approval or a code revision). | The next `submit_code` hands the theory to the Judge (`post_review`) with the last error: "5 code attempts failed; handing to the Judge." With no successful evaluation, the gates fail and the verdict is failed. |

People are not capped. Sending an idea back yourself always works.

Both caps are workspace research settings (`maxRevisions`, `maxCodeAttempts`). They are not shown in Setup; you
can change them through the API or YAML.

### The Coder's queue and `next_step`

The Coder's queue holds every theory in `approved_for_code`, `revise_code`, `code_error` or `coding`. Each queue
item carries a `next_step` and a ready-made instruction, and the queue is sorted by step: evaluate first, then
fix, revise and write.

| `next_step` | When                                                                                             | What the Coder does                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `evaluate`  | In `coding`, the latest code version passed its test, and there is no successful evaluation yet. | Calls `evaluate_strategy(theory_id, params)` at once, with the brief's `evaluation_params`. No rewriting and no reading data again. |
| `fix`       | In `code_error`. The item includes `last_error`.                                                 | Fixes only what the error points at, then calls `submit_code` again.                                                                |
| `revise`    | In `revise_code`. The item includes the Judge's feedback.                                        | Applies the feedback, then calls `submit_code`.                                                                                     |
| `write`     | In `approved_for_code`, or in `coding` without passing code.                                     | Calls `get_theory`, describes each collection once, writes the plugin, then calls `submit_code`.                                    |
| `wait`      | An evaluation of the latest version is running.                                                  | Skips it.                                                                                                                           |
| `done`      | A forward-only theory whose code passed.                                                         | Nothing: the theory leaves the queue and waits for paper tracking.                                                                  |

**Why it matters.** A cycle that runs out of turns right after `submit_code` costs the next cycle one call
(`evaluate`), not a fresh start.

**What `submit_code` does:**

1. It saves the code as the theory plugin's next version. The plugin is named `t<n>_<title slug>`, for example
   `t5_quality_momentum_tilt`.
2. It dry-runs the code with `test_strategy`.
3. It records the outcome on the version.
4. On failure, the theory moves to `code_error` and the reply includes the error and "attempts_left".
5. On success, the reply says: "Passed. Evaluate it once with evaluate_strategy(…)".

### Claims and their 2-hour expiry

When a Coder submits code for a theory, it **claims** the theory: the claim records which agent and when.

- **Others skip it.** While the claim is fresh (under **2 hours**), other Coders don't see the theory in their
  queue. If one tries to submit or evaluate it anyway, the server refuses: "T-7 is being coded by <agent>; pick
  another theory from your brief."
- **Stale claims expire.** After 2 hours the claim is stale, and any Coder can pick the theory up. That covers a
  cycle that died.
- **No claim needed to start.** Theories in `approved_for_code` or `revise_code` can always be started.

### The backlog brake

The **Coder backlog** is the number of theories in `approved_for_code`, `revise_code`, `code_error` or `coding`.
When it reaches **Pause Theorists at (ideas waiting for code)** (default 8):

- **The brief tells Theorists to hold.** "The Coder has 8 ideas waiting for code (the limit is 8): do not propose a
  new theory this cycle. If your queue has a theory sent back for revision, revise it; otherwise reply DONE."
- **New theories are refused.** `submit_theory` refuses a new theory with the same reason. Revisions are not new,
  so they still go through.

The brake stops cheap Theorists from piling up ideas that the slower and costlier Coder cannot work through. If the
Lab's **Coding** column stays full, either raise the limit or give the Coder a stronger model or more turns.

### The research scope enforced on evaluations

When the Coder calls `evaluate_strategy` for a theory:

- **The names.** Any `symbols` or `universe` the agent passes are dropped and replaced by the research scope, for
  example `universe: { top_by_market_cap: 500 }`.
- **The dates.** A missing `start` or `end` is filled from the research window. Exploration can never end inside
  the holdout: "end 2025-06-30 is inside the locked holdout (from 2025-05-04); evaluate up to 2025-05-03, or use
  the one-shot holdout run."
- **What the agent may choose.** The window (inside those bounds), `side`, `top_n`, `rebalance` and
  `plugin_params`.
- **One evaluation per coding round.** The theory must be in `coding`, with code, and not forward-only.
- **Waiting.** The tool waits up to 50 seconds for the result. If the run is still going, the theory moves on by
  itself when it finishes: to post-review on success, or to code error ("Evaluation failed: …") on failure.

### Near-duplicate refusal (theory memory)

Every theory's title, hypothesis and signal logic are **embedded**: turned into a vector that captures their
meaning.

- **When the check runs.** Whenever a theory is submitted or re-submitted for review.
- **The rule.** If its cosine similarity to any other theory, of any status (failed ones included), is **0.9 or
  more**, the server refuses it: "This theory is a near-duplicate of T-3 "12-1 momentum, large caps" (failed,
  similarity 0.93 ≥ 0.9, …). Say what is different in differsFrom, or work on another idea."
- **The way through.** A theory that says what is different (`differs_from`) passes the check. The text then
  appears on the Overview tab as "How it differs from earlier ideas".
- **The embedding model.** The workspace's embedding model is used if there is one. Otherwise a local "lexical"
  vector of hashed words is used: it catches re-submissions and light rewording, but not real paraphrases.
- **Settings.** The threshold (`duplicateThreshold`) and the embedding provider (`embeddingProviderId`) are
  research settings, not shown in Setup.
- **Search.** `search_theories(text)` lets the Theorist see the closest earlier ideas before it proposes.

Failed ideas stay in memory on purpose. Each failure was a trial, and proposing it again under a new name would
be a hidden extra trial.

### Forward-only ideas

Some collections hold weekly snapshots that start in October 2026, so they have no history to backtest:
`analyst_estimates`, `price_target_consensus`, `grades_consensus` and `financial_scores`.

- **The tag.** A theory whose `data_needed` uses any of them is tagged **forward only**.
- **No backtest.** Its evaluation is refused, and it waits for paper tracking (Layer 5).
- **The workaround.** A proxy built from `analyst_events` can be backtested as a separate theory.

---

## Gates and verdicts

Success is **mechanical**. When the Judge calls `set_verdict`, the active gates version is applied to the
theory's latest successful exploration (and its holdout, once there is one). The Judge may **downgrade** a
passing theory, with at least a sentence of reasons, but can **never upgrade** a failing one.

### Every gate and its default

| Gate (as shown in the checklist) | Setup key                | Default                         | Passes when                                                                                            |
| -------------------------------- | ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `sharpe`                         | `minSharpe`              | 0.5                             | the exploration Sharpe is at least 0.5                                                                 |
| `deflated_sharpe`                | `minDeflatedSharpe`      | 0.95                            | the deflated Sharpe probability is at least 95% (the detail shows "over N trials")                     |
| `positive_excess_years`          | `minPositiveExcessYears` | 0.6                             | at least 60% of calendar years beat the S&P 500 (the detail lists each year, for example `2023 +4.1%`) |
| `trades`                         | `minTrades`              | 100                             | at least 100 trades                                                                                    |
| `holdings`                       | `minHoldings`            | 10                              | on average at least 10 names are held per rebalance                                                    |
| `alpha_t`                        | `minAlphaT`              | 2                               | the alpha t-statistic after the factor regression is at least 2                                        |
| `no_blocking_warnings`           | (not editable in Setup)  | `empty_book`, `extreme_returns` | the evaluation raised neither warning                                                                  |
| `holdout` (pending)              | none                     | none                            | always fails until a holdout has run ("pending: no holdout run yet")                                   |
| `holdout_excess`                 | `minHoldoutExcess`       | 0                               | the holdout's excess per year over the S&P 500 is **above** 0                                          |
| `holdout_sharpe`                 | `minHoldoutSharpe`       | 0.3                             | the holdout Sharpe is at least 0.3                                                                     |

If the theory has no successful evaluation at all, there is a single `evaluation` gate, which fails with "no
evaluation yet".

### The metrics, explained

All metrics come from the evaluator's daily return series, **after costs** (commission, slippage and borrow). The
year has 252 trading days.

#### Sharpe ratio

The Sharpe ratio is the mean daily return divided by its standard deviation, times √252. **No risk-free rate is
subtracted**, so it is the raw reward-to-volatility ratio.

> Example: a strategy averages **+0.068%** a day with a daily standard deviation of **1.0%**.
> Sharpe = 0.00068 / 0.010 × √252 = 0.068 × 15.87 = **1.08**. This is T-5's Sharpe.
> The default gate is 0.5. Because cash earned 4–5% over 2023–2025, a Sharpe with the risk-free rate subtracted
> would be lower than the one shown here.

The **holdout Sharpe** is the same measure, computed over the holdout run alone.

#### Deflated Sharpe (the first proof gate)

If you try 60 strategies, the best one looks good by luck alone. The **deflated Sharpe** (Bailey & López de Prado)
is the probability that the true Sharpe is above the Sharpe you would **expect from the best of all the trials run
so far**, given how long the record is and how fat-tailed the returns are.

How it is computed:

1. **The bar to beat.** The expected maximum Sharpe of N trials is computed from:
   - **N**, the workspace's global trial count when this evaluation ran. Every evaluation counts: explorations,
     holdouts and name-subset searches. Reproductions do not.
   - **The spread of the trials' Sharpes**, measured as the variance of the per-day Sharpe of every finished
     evaluation in the workspace.
2. **The probability.** The probability that this strategy's per-day Sharpe beats that bar, adjusted for the number
   of days and the skew and kurtosis (fat tails) of its returns.

> Worked example (illustrative, using T-5-like numbers): Sharpe 1.08 over 3 years (756 days), returns with no
> skew and kurtosis 5, and the trials' Sharpes spread with a standard deviation of 0.6 a year.
>
> - With **10 trials**, the bar is an annual Sharpe of about 0.94. The deflated Sharpe is about **59%**.
> - With **60 trials**, the bar is about 1.41. The deflated Sharpe is about **29%**.
> - Passing the 95% gate with 60 trials would take a 3-year Sharpe of about **2.4**.

This is why most real ideas fail this gate. The more the loop tries, the higher the bar. The value is stored with
each evaluation, so an old evaluation keeps the deflated Sharpe it had with the trial count of its day.

#### Positive excess years

For each calendar year in the window, the strategy's compounded return minus the S&P 500's over the same days.
The gate is the share of years above zero.

> The window 2022-05-03 → 2025-05-03 has four calendar years: 2022 (May–Dec), 2023, 2024 and 2025 (Jan–May).
> Partial years count as full years. With the default 0.6, **3 of 4** (75%) passes and **2 of 4** (50%) fails.
> Example detail: `2022 -3.2%, 2023 +6.0%, 2024 +11.4%, 2025 +2.1%`, which is 3 of 4 and passes.

#### Alpha t (the second proof gate)

Alpha is the return the strategy earns beyond its exposure to known factors.

**The regression.** The strategy's daily returns are regressed on:

- the **market**: the S&P 500's daily return;
- four long-short factors, each built from `features_ranked` on the eligible universe. On each signal date, the
  factor is the top third of names by that field minus the bottom third, equal weight:
  - **momentum** (`mom_12_1_pct`);
  - **value** (`value_score`);
  - **quality** (`quality_score`);
  - **low volatility** (`low_vol_score`).

**The t-statistic.** The intercept is the daily alpha, annualized as (1 + daily)^252 − 1. Its t-statistic uses
**Newey-West** (HAC) standard errors with 5 lags. These correct for returns that are autocorrelated (for example,
because positions are held for weeks) and for changing volatility.

**Reading it.** t ≥ 2 means roughly 95% confidence that the alpha is not zero.

> Example: a quality-momentum tilt earns 19% a year, but most of it is exposure to momentum and quality factors.
> The regression leaves a daily alpha of 0.025% (**6.5% a year**) with a Newey-West standard error that gives
> **t = 1.4**. That fails the gate: the excess return may be repackaged factor exposure, not new skill.

When the eligible universe has more than 600 names, or `features_ranked` is missing, only the market factor is
used. The Factor exposures table then says "market only (no features_ranked or a large universe)".

#### Trades

Trades are counted at every rebalance: each name whose target weight differs from its drifted weight counts as one
trade. That includes topping a held name back up to equal weight. Entries, exits and resizes all count.

> Example: a weekly book of 30 names over 3 years has about 156 rebalances. It records thousands of trades, so it
> passes easily. A **monthly** book of 10 names over 1 year (12 rebalances) records at most about 120 and may fail.

The **Trade returns** chart counts trades differently: as round trips, from entry to exit.

#### Holdings

The average number of names in the book (long plus short) per rebalance.

> Examples: `top_n` 10 long-only gives 10, which just passes. `top_n` 10 long-short gives 20. A plugin that often
> returns no usable scores lowers the average and also raises `empty_book`.

#### Blocking warnings

| Warning           | Meaning                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty_book`      | On some rebalances `signal(ctx)` returned no usable scores for eligible names, usually because of a wrong column name or NaNs. The warning shows the count, out of how many rebalances, and the first date. |
| `extreme_returns` | A held name moved more than 50% in one day: a data problem or a real event worth a look. Check `prices_daily.dq_flags`.                                                                                     |

Either one fails the theory outright.

#### Excess vs the S&P 500, and vs sector

- **Excess vs S&P 500**: the strategy's CAGR minus the S&P 500's CAGR over the same days, shown as "Excess / year"
  (for example +8.2%). The card's footnote shows the **information ratio**: the mean daily excess divided by its
  standard deviation, times √252.
- **vs sector**: the same weights, but each position earns its sector's equal-weight return that day. This tells
  you whether the strategy picked good names, or just sat in a sector that went up. It is shown only for universes
  of 600 names or fewer.

> **Caveat:** the S&P 500 benchmark (`macro_daily.spx_ret_1d`) is the _price_ return of the index level (`^GSPC`), without
> dividends, while strategies earn total returns (`tr_1d`, dividends included). So every "excess over the S&P 500" is
> flattered by roughly the index's dividend yield, about 1.3–1.5% a year. The fix is ticketed as #363.

#### Folds

A fold is one calendar year of the window, scored on its own returns only: return, Sharpe, max drawdown and days.
A year with fewer than 20 trading days is marked `(partial)`.

Plugins are fixed rules, not fitted models, so a fold is an out-of-sample year rather than a refit. The
**positive excess years** gate uses the same years.

### The one-shot holdout

The last **18 months** of price history are the holdout. Exploration can never score those dates or read data
from them: every read is cut at the day before the holdout starts.

The holdout runs only at the verdict:

1. The Judge requests **successful**.
2. **Every exploration gate passes.**
3. The theory has no holdout yet.

Then the theory's single holdout run starts on the same plugin version, with the same names, side, `top_n` and
rebalance. It runs from the holdout start to the latest price date. If it is still running after 50 seconds, the
Judge is told "The holdout run is still going: call set_verdict again in a minute."

**Why the holdout is "one shot":**

- **The claim comes first.** It is recorded before the run starts, so a second attempt for the same theory and code
  version is refused even if the first one failed: "The holdout was already used for this theory and code version
  …; it is one shot".
- **A theory gets one holdout result.** In the research loop, once a theory has a holdout evaluation, later
  verdicts reuse it, even after a code revision.
- **Promising and failed ideas never spend it.** They fail an exploration gate, so they never reach step 2.
- **Reproduce cannot re-run it.** The holdout is excluded from **Reproduce**.

Two details to know:

- **Known issue (#364):** the holdout run gets the exploration's names, side, `top_n` and rebalance, but not
  its `plugin_params`. A plugin tuned through `plugin_params` therefore runs the holdout on its META defaults.
- **The holdout length is locked.** It can be changed (1 to 120 months, API only) only until the first holdout run.
  After that, the boundary is fixed.

### The three verdicts

| Verdict        | Rule (mechanical)                                                                                                                                                                                                                       | What it means                                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Successful** | Every gate passes, the holdout included. The Judge must request successful; it may instead downgrade to failed, with reasons of at least a sentence.                                                                                    | It worked, beat known factors and luck, and held up out of sample.                                                                                                                          |
| **Promising**  | The only failing exploration gates are the **proof gates**, `deflated_sharpe` and/or `alpha_t`; no holdout gate failed; and the excess over the S&P 500 is **positive**. This label comes from the gates, whatever the Judge requested. | It worked (it beat the S&P 500 with a decent Sharpe), but it is not proven to be more than luck across all trials, or more than known factors. It is worth a simulation or a narrower test. |
| **Failed**     | Anything else: it lost to the S&P 500, a performance gate failed (Sharpe, positive years, trades, holdings, warnings), or the holdout failed.                                                                                           | Kept and counted as a trial, never hidden.                                                                                                                                                  |

If the Judge asks for successful on an idea that mechanically failed, the server refuses: "The gates failed, so
the verdict is failed: the Judge can downgrade a passing theory but never upgrade a failing one. Gates v1: sharpe
0.41 (needs 0.5); …". The Judge can also request **revise** instead, which sends one concrete code change back to
the Coder (`revise_code`). This counts against the 3 revisions.

The verdict is stored on the move with the gates version, every gate's value and threshold, the mechanical outcome
and the evaluation ids. The idea page shows exactly what decided it.

**Worked example: T-5.**

| Exploration (2022-05-03 → 2025-05-03)             | Value     | Gate                      |
| ------------------------------------------------- | --------- | ------------------------- |
| CAGR                                              | 19.1%     | (no gate)                 |
| Excess vs S&P 500                                 | +8.2%/yr  | must be > 0 for promising |
| Sharpe                                            | 1.08      | ≥ 0.5: pass               |
| Positive excess years, trades, holdings, warnings | passed    | pass                      |
| Deflated Sharpe                                   | below 95% | fail (proof gate)         |
| Alpha t                                           | below 2   | fail (proof gate)         |

Only the two proof gates failed and the excess was positive, so `outcomeOf` gives **promising**. No holdout was
spent, because an exploration gate failed.

T-5 was judged before the promising label existed (#354), so it was first recorded as failed. At startup the
server re-checks every failed verdict's recorded gates. A verdict that beat the S&P 500 and failed only the proof
gates moves once from `failed` to `promising`, made by the evaluator, with the note:

> "Relabelled (#354): it beat the S&P 500 by 8.2% a year and failed only the proof gates (deflated sharpe and alpha
> t). Promising: worth a simulation or a narrower test, not yet proven."

A theory the Judge downgraded from passing stays failed.

On live, T-5's recorded gates are: Sharpe 1.08, deflated Sharpe **0.43** (needs 0.95), alpha t **1.60** (needs 2),
positive excess years 75%, 1,911 trades, 10 names held on average. Its history shows the relabel entry above. A
verdict given directly as promising (after #354) has no relabel entry.

### Gates versions and locking

- **The first version.** On first use the workspace gets **v1**, with the defaults.
- **New thresholds make a new version.** Changing any threshold (Setup → Success gates, then **Save**) creates the
  next version (v2, v3…) and makes it active. Each version stores a note; edits from Setup are noted "Edited in
  Research → Setup".
- **Locking.** A version is **locked** by the first verdict that uses it, and a locked version never changes. The
  idea page shows `gates vN (locked by the verdict)` for decided ideas, and `gates vN (current)` for undecided
  ones, which are checked against the active version now.
- **Comparing.** Verdicts under different versions are not comparable. The Ideas API can filter by `gatesVersion`;
  there is no control for it on the page.
- **YAML.** `Gates` objects export as `v<n>`. Locked versions import read-only.

#### How-to: Change a gate threshold

Example: you want to accept an alpha t of 1.8, given the small number of years.

1. Open **Research → Setup** and scroll to **Success gates vN**.
2. Change the `minAlphaT` field from `2` to `1.8`.
3. Click **Save**. The message reads "Saved. Gates v2 is now active; verdicts under v1 stay as they were."
4. From now on, new verdicts use v2. Ideas already decided under v1 keep their verdict.

Promising ideas are terminal for the agents: they are not re-judged automatically. To re-test one under v2, open
it and **Send back…** with a note.

---

## Ideas pages

**Purpose.** Ideas is the human view of the research loop's theories: each one with its results, its debate, its
code, every run, and the gates that decided it.

**How to get there.** Click **Ideas** in the sidebar (lightbulb icon), or **All ideas** on the Research Lab.
Board cards and activity entries open one idea.

| URL                                               | Page                                            |
| ------------------------------------------------- | ----------------------------------------------- |
| `/ideas`                                          | The list. Filters are kept in the query string. |
| `/ideas/T-5`                                      | One idea, on its Overview tab.                  |
| `/ideas/T-5/results`, `/review`, `/code`, `/runs` | The other tabs.                                 |
| `/ideas/compare?ids=T-5,T-9`                      | Compare 2–4 ideas.                              |

Every view is a URL, so a link, a reload or Back lands on the same view.

### The list

The header reads **Ideas**, with the line "Theories from the research loop. Open one for its proof pack, the
Judge's review, the code and every run." On the right is a **Compare** button.

**KPI cards** (counts over the whole workspace, whatever the filters)

| Card             | Counts                                                 | Footnote                       |
| ---------------- | ------------------------------------------------------ | ------------------------------ |
| **Successful**   | status successful                                      | "passed every gate"            |
| **Promising**    | status promising                                       | "beat the S&P 500, not proven" |
| **Approved**     | status approved                                        | "by a person"                  |
| **Failed**       | failed plus rejected-as-untestable                     | "kept, never hidden"           |
| **In progress**  | draft through post-review, including the revise states |                                |
| **Forward only** | forward-only ideas                                     | "paper tracking"               |

**The filter bar**

| Control              | What it does                                                                                                                                                 | URL key   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| **Show** (segmented) | **Successful & approved** (the default), **Promising**, **In progress**, **Failed & rejected** (failed, rejected and parked) or **All**.                     | `show`    |
| **Search**           | Placeholder "Search title, hypothesis or T-n". Also matches the signal logic and the family. `T-5` jumps to that idea.                                       | `q`       |
| **Family**           | **All families**, or one family (momentum, quality, …).                                                                                                      | `family`  |
| **Profile**          | **Any profile**. Under Equity: **Long**, **Short**, **Long / short**. Under Options: **Any options idea**, then each structure (Covered call … Iron condor). | `profile` |
| **Sort**             | **Deflated Sharpe** (the default; ties go by Sharpe), **Sharpe**, **Excess / year** or **Most recent**.                                                      | `sort`    |
| **View**             | **Table view** or **Card view** (icons).                                                                                                                     | `view`    |

Under the bar is the count line: "12 ideas · 2 selected for compare (2–4)". If the default view is empty, the page
offers **Show every idea**.

**Table columns:** a select checkbox, **ID**, **Idea** (the title, with "profile · family · forward only" under it),
**Status**, **Side**, **Horizon** (for example `21d`), **Sharpe**, **Deflated**, **Excess / yr**, **Max DD**,
**Holdout** and **Equity**.

- **Holdout** shows "Sharpe · excess", green when the excess is positive and red otherwise. While running it shows
  the status, and `—` when no holdout has run.
- **Equity** is a small sparkline of the equity curve.

The table renders only the rows you can see, so thousands of ideas scroll smoothly.

**Card view** shows the same ideas as cards: ID, status, checkbox, title, "profile · family · horizon", a
sparkline, and **Sharpe**, **Deflated**, **Excess/yr** and **Max DD**.

All numbers on the list come from the idea's **latest successful exploration**. Holdout numbers appear only in the
Holdout column.

#### How-to: Compare ideas

1. On `/ideas`, tick 2 to 4 ideas. A fifth tick is ignored.
2. Click **Compare (n)**.
3. The comparison page shows:
   - an **Equity** chart (growth of 1, after costs), one line per idea;
   - a **Metrics** table: CAGR, Sharpe, Sortino, Deflated Sharpe, Excess / year, Max drawdown, Alpha t-stat,
     Trades and Turnover / year. The best value in each row is highlighted: the lowest for turnover and the
     shallowest for drawdown;
   - **Return correlation**: daily returns, on the days both ideas have;
   - **Holdings overlap**: names in common in the final books, as a share of the smaller book.

   High correlation or high overlap means two "different" ideas are really the same bet.

### The idea page

**Breadcrumbs:** **Ideas** › `T-5`.

**The header:**

- the id and title, for example `T-5 Quality-momentum tilt in large caps`;
- the status pill, with **forward only** if it applies;
- a profile chip, for example `Equity · long / short`;
- the family;
- the horizon, as "21-day horizon";
- `gates v1 (locked by the verdict)` or `gates v2 (current)`;
- "1 revision · 3 trials";
- the models that acted, per role, for example `Theorist: gemini-3.8-flash`, `Judge: gemini-3.8-flash`,
  `Coder: gemini-4-argon`.

**Buttons** (all but Export are admin only, and each appears only when it applies):

| Button          | Shown when                                                               | What it does                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Approve**     | status successful                                                        | → approved                                                                                                                                                                               |
| **Park**        | successful, approved or promising                                        | Opens "Park T-5", with an optional note. → parked                                                                                                                                        |
| **Reject…**     | successful, approved or promising                                        | Opens "Reject T-5" ("Why is it rejected?"). Needs at least 5 characters. → **failed**                                                                                                    |
| **Send back…**  | successful, promising, approved, failed, parked, rejected or post-review | Opens "Send T-5 back to the Theorist" ("What should the Theorist change?"). Needs at least 5 characters. "The comment reaches the Theorist in the next research cycle's brief." → revise |
| **Reproduce**   | it has a successful exploration                                          | Re-runs the latest exploration. See [Reproduce](#reproduce-an-evaluation).                                                                                                               |
| **Simulate**    | it has a successful exploration                                          | Opens `/simulations?new=T-5` to run the idea through the paper broker (Layer 5, covered in another part).                                                                                |
| **Export YAML** | always                                                                   | Downloads `idea-T-5.yaml`: the theory with its debate, the plugin with every version, and its evaluations.                                                                               |

After an action, a notice confirms it, for example "T-5 is now parked."

**KPI cards**

| Card            | Value                                           | Footnote                                                   |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| Sharpe          | from the exploration                            | "exploration, after costs"                                 |
| Deflated Sharpe | as a percentage                                 | "over N trials" (see the note below)                       |
| Excess / year   | over the S&P 500                                | "over the S&P 500"                                         |
| Max drawdown    |                                                 |                                                            |
| Holdout         | the holdout Sharpe, or its status, or "not run" | "excess X · evaluated once", or "one shot, at the verdict" |

The deflated Sharpe card's footnote shows the idea's own trial count (its evaluations). The percentage itself was
computed against the **workspace's** trial count at the time of the evaluation.

**Gates panel.** A checklist with columns **Gate**, **Value**, **Threshold** and **Result** (pass or fail). Hover a
row to see its detail, for example the per-year excess. Below the checklist, a decided idea shows "Mechanical
verdict: **promising**".

- **A decided idea** shows the gates exactly as recorded at the verdict.
- **An undecided idea** is checked against the active gates now, so it shows `holdout` as pending.

**Judge panel.** The Judge's latest decision: the new status, the time, the model, and the reasoning. Below it is
**Read the whole review**. Before any review the panel reads "The Judge has not reviewed this idea yet."

#### Overview tab

| Section                           | Content                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Hypothesis                        | The claim.                                                                                              |
| Why it should work                | The rationale.                                                                                          |
| Signal                            | The signal logic in words: what is ranked, how, and when.                                               |
| What would prove it wrong         | The falsification test.                                                                                 |
| Universe                          | As the Theorist wrote it, for example `universe_daily (in_universe)`. The research scope still applies. |
| How it differs from earlier ideas | Only when the near-duplicate check was overridden.                                                      |
| **Data** (side panel)             | Chips for each `collection.field`. Clicking one opens that collection in the Schema Catalog.            |
| Forward-only notice               | "Uses snapshot-only data, so it can only be tracked forward, not backtested."                           |
| **Tags**                          | The idea's tags.                                                                                        |

#### Results tab

This tab holds the proof pack of the latest exploration:

- **The header:** "Exploration · v2 · trial 47", the period, the evaluator version, "prices as of <date>", and
  **Open the evaluation**.
- **The Holdout panel** (when one ran), with an **evaluated once** pill. It shows Sharpe, CAGR, excess / year and
  max drawdown, plus **Open** and an expandable **Holdout proof pack**.
- **Names it works for**: the subset search. See [Names it works for](#names-it-works-for-subsetpanel).
- **The full evaluation report**, the same as the Evaluations page.

With no finished evaluation, the tab reads "No finished evaluation yet." with a link, **See the runs**.

#### Review tab

The debate, turn by turn. The intro reads: "N events. Numbers the agents cite are checked against this idea's
evaluations: **sourced** links to the evaluation it comes from, **unsourced** matches none (N here)."

- **Each turn shows** the role's initial (T, J, C, E or P for Person), the role, a description, the new status
  pill, the model and the time. Descriptions are "proposed the idea", "revised the idea", "commented", "linked an
  evaluation", or a move such as "Post-review → Promising".
- **Number chips.** Every number an agent writes is checked against the idea's evaluation records (summary,
  excess, factors, trial context, folds, regimes).
  - The check allows for rounding and for percentage versus fraction, so "1.08" and "8.2%" both match.
  - Small whole numbers (under 10), years (1900–2100), `T-3`, `v2` and `#110` are ignored.
  - A sourced chip opens its evaluation. An unsourced (red) chip means the agent cited a number no evaluation
    contains, which is a reason to be sceptical of that turn.
  - People's comments and system links are not checked.
- **Gates at the verdict (vN)** expands on the verdict turn and shows the gates as they were.
- **Add a comment** (admin). The placeholder reads "Notes for the team; to ask the Theorist for changes use Send
  back." **Comment** needs 2 or more characters. A comment does **not** change the status, and the agents do not
  act on it.

#### Code tab

- **Version list:** the plugin name, then one row per version, for example `v1` (**error**), `v2` (**passed**,
  **current**), each with its note or time.
- **Version body:** `v2` and its code hash, the time, a **Diff against v1** toggle, and **Copy**. Below them are the
  note, any error (in a red box), and the code in a read-only editor (a side-by-side diff when the toggle is on).
  Last comes "Evaluated with this version: explore (succeeded), holdout (succeeded)", with links.
- Before any code: "The Coder has not written code for this idea yet."

#### Runs tab

Every evaluation of the idea, newest first. The tab refreshes every 4 seconds while one is running.

Columns: **When**, **Mode**, **Status**, **Version**, **Trial**, **Period**, **Sharpe**, **Excess / yr**,
**Record** (the first 12 characters of the record hash) and a per-row **Reproduce**.

- **Mode** is `explore` or a **holdout** pill. A reproduction carries **reproduced ✓**, **mismatch** or
  **reproducing**.
- Click a row to open `/evaluations/<id>`.

### Human actions

| Action     | From                                                                   | To        | Needs                      |
| ---------- | ---------------------------------------------------------------------- | --------- | -------------------------- |
| Approve    | successful                                                             | approved  | nothing                    |
| Park       | successful, approved, promising                                        | parked    | an optional note           |
| Reject…    | successful, approved, promising                                        | failed    | a reason of 5+ characters  |
| Send back… | successful, promising, approved, failed, parked, rejected, post-review | revise    | a comment of 5+ characters |
| Comment    | any                                                                    | unchanged | 2+ characters              |

**Sending an idea back** puts it in the Theorist's queue. The brief shows your comment as the feedback. The idea
then goes through pre-review and coding again:

- **New versions, not a new plugin.** New code is a new version of the same plugin.
- **Trials add up.** New evaluations add to its trials.
- **The holdout is not re-run.** In the loop, a theory keeps the holdout result it already has.

Your own moves are never capped.

#### How-to: Read an idea's results

Example: T-5, promising.

1. Open `/ideas?show=promising` and click **T-5**.
2. **Read the header and KPIs:** Sharpe 1.08, Excess / year +8.2%, and Holdout "not run". Promising ideas never
   spend the holdout.
3. **Read the Gates panel.** `sharpe`, `positive_excess_years`, `trades`, `holdings` and `no_blocking_warnings`
   pass. `deflated_sharpe` and `alpha_t` fail, and `holdout` is pending. The panel says "Mechanical verdict:
   promising".
4. **Open the Results tab.** Look at:
   - the **Equity** chart against the S&P 500;
   - **Return by year** and the folds table: is the excess in every year, or mostly in one?
   - **Factor exposures**: a large momentum or quality beta with a big t explains why the alpha t is low;
   - **Contribution by sector**: is it all one sector?
   - **Results by name**: does a handful of names carry it? Check the "best 10% of names made X% of the gains"
     line.
5. **Open the Review tab** to read the Judge's reasoning. Check for red (unsourced) numbers.
6. **Decide what next:**
   - **Simulate** it on the paper broker;
   - run **Find the names** to see if it works on a subset;
   - **Send back…** with a narrower variant;
   - or **Park** it.

#### Reproduce an evaluation

**Reproduce** re-runs an exploration with the **same code version and the same parameters**.

- **Not a new trial.** It keeps the original's trial number.
- **The check.** It compares record hashes. The notice reads "Reproduced: the record hash matches the original."
  or "The reproduction does not match the original record (see Runs)."
- **Why a mismatch matters.** A mismatch means the data under the window changed since the original run, or the
  evaluator changed.
- **Limits.** The holdout and unfinished runs cannot be reproduced.

---

## Evaluations page

**Purpose.** This page holds the trusted evaluator's records: every backtest of every plugin version, with the full
proof pack.

**How to get there.** It is **not in the sidebar** (it is labelled a "dev view"). Open `/evaluations` directly, or
follow **Open the evaluation** on an idea's Results tab, a Runs row, a sourced number chip, or the `page` link an
agent receives from `evaluate_strategy`.

### The list (`/evaluations`)

The heading reads **Evaluations**, with "N shown · N trials in this workspace · dev view". It shows the newest 200.

Columns: **Started**, **Plugin** (`t5_quality_momentum_tilt v2`, with a **holdout** pill when it applies),
**Period**, **Status**, **CAGR**, **Sharpe**, **Max DD** and **Trial**.

### One evaluation (`/evaluations/<id>`)

**The header:**

- **← Evaluations**, then the plugin and version, the status pill, and **holdout (one shot)** when it applies.
- The meta line: the period, "N symbols" or "whole universe", "name subset", the trial, the code hash, the
  evaluator version, and "prices as of <date>".
  - Note: an S&P 500 proxy run passes no symbol list, so it shows **"whole universe"** even though it was limited
    to the top 500 by market cap. **Provenance → params** shows the `universe.top_by_market_cap` actually used.
- Export / import buttons for the `Evaluation` YAML object.

**Failed evaluation.** A red box shows the error type and message, any contract problems (one per line), and the
plugin's own line numbers.

**Subset record.** A **Name subset** panel shows the result, with **The evaluation it was picked from**.

**Successful exploration** (not itself a subset). The **Names it works for** panel appears.

**The report** (shared with the idea's Results tab):

| Block                                     | Content                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KPI cards                                 | **CAGR** (total return); **Sharpe** (Sortino); **Max drawdown** (Calmar = CAGR ÷ max drawdown); **Hit rate** (the share of non-zero days that were positive; footnote "N trades · N× turnover/yr"); **Excess vs S&P 500** (IR, and "vs sector"); **Deflated Sharpe** ("over N trials") |
| Warnings                                  | One line per warning code, with its count and hint.                                                                                                                                                                                                                                    |
| **Equity**                                | Growth of 1 after costs, strategy against the S&P 500.                                                                                                                                                                                                                                 |
| **Drawdown**, **Rolling Sharpe**          | The drawdown series. The rolling Sharpe uses a 126-day window, about 6 months.                                                                                                                                                                                                         |
| **Return by year**                        | A bar per fold.                                                                                                                                                                                                                                                                        |
| **Trade returns**                         | A histogram of round-trip trades, from entry to exit: "N trades · win rate X · median Y".                                                                                                                                                                                              |
| **Walk-forward folds (by calendar year)** | Fold, Return, Sharpe, Max DD, Days.                                                                                                                                                                                                                                                    |
| **Factor exposures**                      | The caption gives alpha per year, its t and R². The table shows Factor, Beta and t (Newey-West) for market, momentum, value, quality and low_vol.                                                                                                                                      |
| **By regime**                             | Days, return and Sharpe in "S&P 500 trend above / below" (the 200-day average) and "VIX high / normal" (VIX ≥ 25 is high).                                                                                                                                                             |
| **Contribution by sector**                | Horizontal bars of each sector's summed daily contribution.                                                                                                                                                                                                                            |
| **Results by name**                       | See below.                                                                                                                                                                                                                                                                             |
| **Provenance**                            | The record hash, plugin (name, version, hash, meta), params, costs, period, data snapshot, reader stats and the final holdings.                                                                                                                                                        |
| Footer                                    | "N trading days · N rebalances".                                                                                                                                                                                                                                                       |

### Results by name (ByNameTable)

This table shows which names in the scope the strategy actually worked for.

**The summary line**, for example: "212 names held · 131 added to the return, 81 took away · the best 10% of names
made 58% of the gains. Contribution is before costs." When more than 1,000 names were held, it adds "showing the
best and worst 500".

**Find a ticker or sector** filters the rows.

| Column              | Meaning                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Name**            | Ticker. Hover to see the security id.                                                                                               |
| **Sector**          | Current sector.                                                                                                                     |
| **Contribution**    | Sorts the table. Summed daily weight × return over the window, before costs. All names together add up to the sector contributions. |
| One column per year | The contribution in that calendar year.                                                                                             |
| **Trades**          | Sorts. Round trips in that name.                                                                                                    |
| **Hit rate**        | Sorts. The share of its round trips that made money.                                                                                |
| **Avg trade**       | Sorts. Its mean round-trip return.                                                                                                  |
| **Avg weight**      | Its average absolute weight over the window.                                                                                        |
| **Days held**       | Sorts. Days long plus short, for example `220 (40 short)`.                                                                          |

The table shows 25 rows at first; **Show all N** expands it.

A "best 10% made 58%" line means a few names carry the result. Picking those names from this table is **not** a
result in itself, because they were chosen on the same data that scored them. That is what the subset search is
for.

### Names it works for (SubsetPanel)

The heading reads **Names it works for**, with the note: "Picks the best names on the first two thirds of the
window, then runs the strategy on only those names over the last third and compares them with random sets of the
same size. Counts as one trial."

| Control                             | What it does                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| **Names**                           | How many names to pick (`top_k`), from 2 to 200, default 20.                               |
| **Find the names** / **Searching…** | Starts the search (admin). While it runs: "Running: about 2 to 15 minutes, by scope size." |
| **Earlier searches (N)**            | Previous searches, each with its date, the number of names, and "shown" or "not shown".    |

**How it works:**

1. **Split the window.** By default the window is split at the year boundary nearest **2/3** of the way through,
   keeping at least 40 sessions on each side. That lets it reuse the evaluation's per-name results by year. With
   another metric, or truncated results, it splits at exactly the fraction and runs the pick period instead.
2. **Pick.** On the whole scope over the pick period, it keeps names held at least **10 days** (and at least 1
   trade) with a **positive** contribution. It ranks them by contribution and takes the best `top_k`. It fails if
   fewer than min(top_k, 5) qualify.
3. **Check.** Over the rest of the window, it runs the same plugin on **only the chosen names**. The book is
   capped at half of them (for 20 names, at most 10 held at a time), so the signal still has to choose.
4. **Baselines.** It compares the chosen names with:
   - the **whole scope** over the same check period;
   - **40 random sets** of the same size, drawn from the names the pick period held. The random sets are seeded
     from the plugin hash and params, so the same inputs give the same record.
5. **The p-value.** p = (1 + random sets with a Sharpe at or above the chosen names') ÷ (1 + 40).
   - It is **shown** when **p ≤ 0.05 and the chosen names' Sharpe is positive**.
   - With 40 random sets, the chosen names must beat at least **39** of them: p = 2/41 = 0.049. Beating 38 gives
     p = 3/41 = 0.073, which is not shown.

**What you see in the result:**

- **A pill and verdict:** **shown out of sample**, "The chosen names beat random subsets of the same size out of
  sample". Or **not shown**, "Not shown: the chosen names did not beat random subsets clearly enough out of
  sample".
- **A table** over the check period: **The N chosen names**, **The whole scope**, and **40 random sets of N
  (average)**, with Sharpe, CAGR, Excess / year and Max drawdown. A note says "the chosen names beat X of 40 · p =
  0.049".
- **A Sharpe strip:** a dot per random set, the chosen names in blue, and the whole scope as a dashed orange line.
- **How the names were picked**, for example: "Picked on 2022-05-03 → 2023-12-29 (by contribution, held at least
  10 days; 164 of 212 names held qualified; from the evaluation's results by year). The strategy holds 10 of them
  at a time."
- **Chips** for the chosen names. Hover one to see its sector and pick-period contribution.
- **Open the check run.** The check run is a new evaluation, marked "name subset", whose metrics are out of sample.

**Example for this window.** The window 2022-05-03 → 2025-05-03 has about 756 sessions. Two thirds is around May
2024; the nearest year boundary is the first session of 2024. So the names are picked on **2022-05-03 →
2023-12-29** and checked on **2024-01-02 → 2025-05-03**, about 16 months.

A search must start from a successful exploration that ends before the holdout. It cannot start from a holdout or
from another subset.

Only **Names** is on screen. The other options (`metric`, `min_days`, `min_trades`, `pick_fraction`, `n_random`
from 19 to 200, and `alpha`) are available through `POST /api/evaluations/<id>/subset`.

#### How-to: Find the names an idea works for

1. Open the idea (for example T-5) and go to **Results**. Or open its exploration evaluation.
2. In **Names it works for**, leave **Names** at `20` or set it, then click **Find the names**.
3. Wait 2–15 minutes. The panel refreshes itself.
4. Read the pill:
   - **Shown out of sample** means the chosen 20 beat at least 39 of 40 random 20-name sets over the check period
     with a positive Sharpe. That is evidence the strategy works for those names, beyond luck in picking them.
   - **Not shown** means the "best names" were mostly hindsight.
5. Remember the search cost one trial, which raises the bar for every later deflated Sharpe. Turning a
   shown subset into its own idea, checked once on the holdout on those names, is the next part of #325 and is
   not built yet.

### How an evaluation runs (engine.py)

The trusted evaluator is fixed, versioned platform code. It runs in the Python executor container, which can reach
only this workspace's database. Each evaluation has up to an hour and 4 GiB of memory.

1. **Walk the rebalance dates.** Every session for `daily`, the first session of each ISO week for `weekly`, or
   the first session of each month for `monthly`.
2. **Find the eligible names on each date.** These are the names with `universe_daily.in_universe` on that date
   (falling back up to 5 sessions back), limited to the top N by that day's market cap for the S&P 500 proxy, or
   to the symbol list. The plugin's optional `universe(ctx)` can narrow this further.
3. **Score.** It calls `signal(ctx)` with `ctx.date` set to that date. Every read through `ctx.read_df` is cut
   **point in time**:
   - Layer 2 rows by `as_of_date ≤ ctx.date`;
   - Layer 1 rows by their known-at rule, for example insider trades by filing date, and statements by
     `acceptedDate` with a 45/90-day fallback;
   - `corporate_actions` from the next session.

   Static tables (`trading_calendar`, `securities`) are uncut. Current-only and undocumented collections are
   refused. A filter that asks for future dates returns nothing and counts as a lookahead attempt.

4. **Build the book.** Names are ranked by score, with ties broken by security id. The book is **equal weight**:
   - `long`: the top `top_n`;
   - `short`: the bottom `top_n`;
   - `long_short`: both, with half the gross on each side.

   Gross is 1.0 (`sizing.gross_limit`).

5. **Execute the next day.** Trades fill at the **close one session after** the signal date
   (`execution_lag_days: 1`). Only names with a price that day can be traded. The new book earns from the following
   session.
6. **Charge costs.** Each rebalance costs **commission 1 bp + slippage 5 bps = 6 bps** on the traded weight.
   - Replacing the whole book trades 200% of weight (sell 100%, buy 100%), so it costs 12 bps.
   - Shorts pay **borrow of 50 bps a year** on their weight, charged daily.
7. **Hold and drift.** Between rebalances, weights drift with each name's daily **total return**
   (`prices_daily.tr_1d`, else `ret_1d`).
8. **Handle delistings.** A held name whose prices stop, and which is no longer active, takes a **−30%** delisting
   return once and is dropped.
9. **Record.** The evaluator writes the summary, excess, by regime, factors, by sector, trade stats, series, folds,
   warnings, rebalances, final holdings and provenance. A `record_hash` covers all of it, so identical inputs give
   an identical record. The deflated Sharpe and the by-name results sit outside the hash.

The costs come from `pipeline/config/backtest.yaml`, the platform defaults, not a page setting.

---

## The strategy plugin contract

A plugin is a short Python module. The Coder writes it and the trusted evaluator runs it.

| Part                | Required | Contract                                                                                                                                                                                                                                                                 |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `META = {...}`      | yes      | A literal dict. `side`: `long`, `short` or `long_short`. `horizon_days`: a positive integer. `rebalance`: `daily`, `weekly` or `monthly`. `top_n`: a positive integer. Optional: `description` and `params` (defaults, read as `ctx.params`). Any other key is an error. |
| `signal(ctx)`       | yes      | Returns `{security_id: score}`. Higher is better. Non-numeric, NaN and infinite scores are ignored.                                                                                                                                                                      |
| `universe(ctx)`     | no       | Returns the security ids to consider on `ctx.date`. They are intersected with the eligible names.                                                                                                                                                                        |
| `review(ctx, held)` | no       | For the paper broker (Layer 5): exits for held names, `{security_id: "invalidation" \| "p_outperform"}`.                                                                                                                                                                 |

**What `ctx` offers**

- `ctx.date`: the date as `YYYY-MM-DD`.
- `ctx.params`: META params overridden by `plugin_params`.
- `ctx.universe_ids`: the eligible names that day.
- `ctx.read_df(collection, filter=None, columns=None, lookback_days=None)`: a pandas DataFrame cut point in time,
  with an `as_of_date` column.
- `ctx.days_ago(n)` and `ctx.trading_days_ago(n)`.

**Sandbox rules.** These checks are static, and each problem is reported with its line number.

- **Imports.** Only `math`, `statistics`, `numpy`, `pandas`, `datetime`, `collections`, `itertools`, `functools`,
  `typing`, `dataclasses`, `random`, `re`, `bisect`, `heapq` and `operator`.
- **Forbidden names.** `eval`, `exec`, `compile`, `open`, `__import__`, `getattr`, `setattr`, `globals` and others.
- **Forbidden attributes.** No private attributes (`_x`), no file IO (`to_csv`, `load`, `savetxt` and so on), and
  no `read_*` other than `read_df`.
- **No shared state.** No `global` or `nonlocal`.

Every saved change is a new version, and the `sha256:` hash of the code pins what each evaluation ran.

### Worked plugin example

A long-short quality-momentum composite, rebalanced monthly: long the 25 best names and short the 25 worst. The
fields are the ones the evaluator also uses for its factors. Confirm them in the Schema Catalog before relying on
them.

```python
import numpy as np

META = {
    "side": "long_short",
    "horizon_days": 21,
    "rebalance": "monthly",
    "top_n": 25,
    "description": "Quality + 12-1 momentum, ranked within the scope; long the best 25, short the worst 25",
    "params": {"w_quality": 0.5},
}

def signal(ctx):
    f = ctx.read_df(
        "features_ranked",
        columns=["security_id", "quality_score", "mom_12_1_pct"],
        lookback_days=7,                        # only rows known in the last week
    )
    if f.empty:
        return {}
    last = f.dropna().sort_values("as_of_date").groupby("security_id").tail(1)
    w = float(ctx.params.get("w_quality", 0.5))
    q = last.quality_score.rank(pct=True)       # 0..1 within today's names
    m = last.mom_12_1_pct.rank(pct=True)
    score = w * q + (1 - w) * m
    return dict(zip(last.security_id, score.astype(float)))
```

How the evaluator treats this plugin:

- **Each month.** On the first session of each month, it scores the eligible names (the top 500 by market cap that
  day), goes long the 25 highest and short the 25 lowest at 50% gross each, and trades at the next day's close.
- **Every day.** It charges 6 bps on the traded weight and 50 bps a year on the short side.
- **Parameters.** The Coder can try `plugin_params: {"w_quality": 0.7}` without changing the code. Each such
  evaluation is still a new trial.

A simpler real example, kept in `deploy/config-io/exports/strategy-plugins.yaml` as `mom_12_1`, is 12-1 momentum:
the 10 strongest names over the last year, skipping the last month, monthly, long only.

### test_strategy: the dry run

`submit_code` calls `test_strategy` before saving the result on the version. You can also call `test_strategy`
directly on the research connection.

**What it runs.** The contract check, plus `signal(ctx)` through the same point-in-time reader:

- on about **20 names**: the largest by market cap on the last sample date, or the symbols you pass;
- on **4 dates**: the readable end (the day before the holdout) and about 1, 3 and 6 months before.

**What it returns.**

- **On failure:** the error type and message with the plugin's own line numbers. For a missing column, it also
  lists the columns the collection really has.
- **On success:** a sanity summary: names scored per date, NaN or non-numeric scores, and unknown names.
- **Warnings:**
  - `empty_signal`, `unknown_names`, `missing_columns` and `lookahead_blocked` **fail** the test;
  - `empty_on_some_dates`, `nan_scores` and `constant_scores` are reported but pass.

**What it never does.**

- It never returns performance numbers, so fixing code cannot turn into tuning it to the gates.
- It is **not a trial**.

**Version history.** Every attempt is saved as a version with its outcome (`error` or `tested: passed`). That is
what the idea's Code tab shows. After 5 failing attempts in a row, the reply says to stop and hand the plugin to
the Judge.

---

## YAML and records

Following the project rule that everything is a YAML object (`apiVersion: stockharness/v1`):

- **`ResearchSettings`** exports the research setup. Models and skills are referenced by name, and steering notes
  stay in the workspace.
- **`Gates`** exports each version as `v<n>`. Locked versions import read-only.
- **`Theory`** exports with its full debate, links and trial count. Import adds its trials to the workspace's
  count, so the deflated Sharpe stays honest.
- **`StrategyPlugin`** exports with its code verbatim and its hash.
- **`Evaluation`** exports as an immutable record. Importing never re-runs it.
- **Export YAML** on an idea bundles the idea's theory, plugin and evaluations into one file.

Research settings and gates have no export button of their own: export them from **Settings**, whose export/import
covers every kind (see Part 4, Everything as YAML).

---

# Part 4: Simulations and the workspace

This part covers Layer 5 and the **Workspace** group of the sidebar:

- **Simulations.** One or more ideas traded together as one paper book: real share counts and cash, costs,
  borrow, dividends, splits, sizing and exits with reasons.
- **Inbox.** Questions and approval requests from agents that are waiting for a person.
- **Executions.** Every harness run, with its status, input, output and the step-by-step trace.
- **Integrations.** API keys, the API explorer, webhooks and embedded chats.
- **Settings.** Model providers, email, your profile, Python secrets, configuration as YAML, and the team.
- **Everything as YAML.** How every object exports and imports as a `stockharness/v1` document.
- **A worked example.** Setting up Gemini on Vertex AI correctly, and what its two common errors mean.

In the sidebar, **Simulations** is the last item of the **Build** group. Under the **Workspace** label come
**Inbox**, **Executions**, **Integrations** and **Settings**. Clicking your name at the bottom of the sidebar also
opens **Settings**.

### Terms used in this part

| Term                     | Meaning                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Book**                 | The combined portfolio of all ideas in a simulation: positions, cash and their value on each trading day.                                          |
| **Paper broker**         | The simulator's ledger (`pipeline/strategy/broker.py`). It holds shares and cash and steps one trading session at a time. No real orders are sent. |
| **NAV**                  | Net asset value: cash plus the market value of all positions (shorts count negative).                                                              |
| **Fill**                 | One executed trade in the ledger (a buy or a sell of some shares at a price). The code calls these _orders_.                                       |
| **Trade (round trip)**   | An entry and its exit for one name in one idea, with its P&L, return, dividends, costs, borrow and the reason it ended.                            |
| **Rebalance**            | A day on which an idea's signal produces new target weights and the book trades to them.                                                           |
| **Gross / net exposure** | Gross = long value + short value, as a share of NAV. Net = long − short, as a share of NAV.                                                        |
| **Holdout**              | The last months of price history, locked away from exploration. A simulation may not read it unless you allow it.                                  |
| **Pinned version**       | The exact version of an idea's strategy plugin (its Python code) that a simulation runs. It is fixed when the config is saved.                     |
| **Run (execution)**      | One run of a harness or agent. Runs appear on **Executions**. Simulations are not runs; they have their own page.                                  |
| **Human request**        | A question or an approval an agent's run is waiting on. It appears in the **Inbox**.                                                               |
| **Object**               | Anything StockHarness manages (an agent, a transform, a theory, a simulation config…). Every object exports and imports as YAML.                   |

---

## Simulations

### Purpose

An evaluation tests one idea on its own, with the evaluator's standard rules. A **simulation** asks a different
question: what happens if you actually trade one or more ideas together, with a fixed amount of capital? It runs
the ideas through the paper broker as **one book**, with real share counts and cash. You can choose how to split
capital across ideas, how to size each idea, which exits to add, and the costs.

Simulations are always started by a person. The research loop never starts one: no research agent or cycle calls
the simulations API, and starting or deleting a simulation needs an administrator. A simulation is also the step
before paper trading, which comes in M7 (the **Go live (paper)** button is shown but disabled).

### How to get there

- Sidebar: **Simulations** (URL `/simulations`).
- One run: `/simulations/<id>`, with tabs at `/simulations/<id>/trades`, `/positions`, `/attribution` and
  `/config` (the Performance tab is the bare `/simulations/<id>`).
- From an idea: the **Simulate** button on an idea's page opens the new-simulation form with that idea already
  ticked (`/simulations?new=T-12`). The button shows for administrators once the idea has an explore-period
  evaluation.
- The Map page's Simulations column also says "Open an idea and press Simulate." when there are none yet.
- A URL such as `/simulations?new=T-12,T-15` opens the form with both ideas picked. Adding `&clone=<id>` opens it
  as a copy of an existing run.

### The list page

The header reads **Simulations**, with the line "Ideas run as one book through the paper broker: real shares and
cash, costs, borrow, dividends and splits, exits with reasons. Open a run for its performance, trades, positions
and attribution." Administrators see **New simulation** on the right.

With no runs you see "No simulations yet." and a hint that you can start one here or from an idea's page.

The table lists runs, newest first (up to 500). Click a row to open the run.

| Column        | What it shows                                                                                                                                   | Example                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Name**      | The config name. "uses the holdout" appears under it when the run's period reaches into the holdout.                                            | `Momentum + low vol`      |
| **Ideas**     | One chip per idea. Clicking a chip opens that idea's page (not the run).                                                                        | `T-12` `T-15`             |
| **Period**    | Start → end of the simulation.                                                                                                                  | `2016-05-09 → 2025-05-09` |
| **Status**    | `running`, `succeeded` or `failed`. A running row also shows the estimate ("≈ 3 min"). A failed row shows the first 60 characters of the error. | `running ≈ 2 min`         |
| **CAGR**      | Compound annual growth rate of the book.                                                                                                        | `11.4%`                   |
| **Sharpe**    | Annualised Sharpe ratio of daily returns.                                                                                                       | `0.92`                    |
| **Max DD**    | Largest fall from a running peak.                                                                                                               | `-23.1%`                  |
| **Final NAV** | Book value on the last day, in USD.                                                                                                             | `$2,640,113`              |
| **Created**   | When the run was started.                                                                                                                       | `11/9/2026, 4:12:03 PM`   |

While any run is `running`, the list refreshes itself every 4 seconds.

### The new-simulation form

**New simulation** (or **Simulate** on an idea, or **Clone and edit** on a run) opens a wide form titled
**New simulation** (or **Clone and edit a simulation**). As you type, the form sends the config to the server,
which checks it, pins the code versions, resolves the scope and returns an estimate (about half a second after
you stop typing).

#### Name and ideas

| Field     | What it does                                                                                                                                                                                                                                                                                                        | Example                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **Name**  | The config's name (up to 120 characters, no slashes or control characters). It defaults to "T-12 + T-15 simulation", or "New simulation" with no ideas. Saving uses this name: **a run with the same name as a saved config replaces that saved config.** Earlier runs keep their own frozen copy.                  | `Momentum + low vol, RP` |
| **Ideas** | Tick up to 8 ideas (the legend shows "(n of up to 8)"). Each line shows the idea's `T-n`, title, status, and "Sharpe … · …% / yr". An idea without evaluated code is greyed out with "no evaluated code yet" and can't be ticked. With no ideas at all the box says "No ideas yet: the research loop creates them." | `T-12`, `T-15`           |

An idea can be picked if it has an evaluation Sharpe, or its status is `coding` or `evaluated`. The server still
refuses an idea that has no strategy plugin: "T-n has no code yet; the Coder writes it after the Judge approves".

#### Period

| Field                           | What it does                                                                                                                                                                   | Example                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| **Start**, **End**              | The first and last day of the simulation. Start must be on or before end. The default is the 10 years ending at the last readable date (the day before the holdout), or today. | `2016-05-09`, `2025-05-09` |
| **1y 3y 5y 10y**                | Presets: the last N years, ending at the last readable date.                                                                                                                   |                            |
| **Allow the holdout (after …)** | Lets the end date go past the holdout boundary. The run is then marked "uses the holdout".                                                                                     | off                        |

If the end is inside the locked holdout, a notice appears:

- Without the box ticked (red): "The end is inside the locked holdout. End by 2025-05-09, or allow the holdout."
  **Launch** stays disabled.
- With it ticked (amber): "This run reads the holdout. Results after it are no longer an untouched test."

Reading the holdout in a simulation spoils it as an untouched test for you as a reader. Leave it off unless you
mean it. A simulation that reads the holdout does not use up any idea's one-shot holdout (the simulation code
never touches holdout runs), and the run is marked as using the holdout. But looking at holdout results before an
idea's verdict weakens what the holdout proves, so keep it for ideas that already have their verdict.

#### Book

| Field                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Example                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **Capital (USD)**           | Starting cash. At least 1,000, in steps of 1,000. Default 1,000,000.                                                                                                                                                                                                                                                                                                                                                                                                            | `1000000`               |
| **Allocation across ideas** | How capital is split across ideas. **Equal**: 1/N each. **Risk parity**: each idea gets a share inversely proportional to the volatility of its own book's daily returns over the trailing 63 sessions (it falls back to equal until every idea has at least 20 days of history). **Custom weights**: you type a % per idea. Hint: "Risk parity: inverse volatility of each idea's book".                                                                                       | `Risk parity`           |
| _idea_ **weight (%)**       | Shown only for **Custom weights**, one field per idea. A total under 100% leaves the rest in cash; a total over 100% is scaled down to 100%. Every idea needs a weight.                                                                                                                                                                                                                                                                                                         | `T-12 weight (%)`: `60` |
| **Sizing**                  | **Equal weight (as evaluated)**: each idea's book exactly as the evaluator builds it, scaled to its allocation. **Quarter-Kelly**: the allocation is further scaled by 0.25 × shrunk mean ÷ variance of the idea's own book returns up to the day before (the mean is shrunk by n / (n + 252)); the factor is kept between 0 and 1, and with fewer than 63 days of history the full allocation is used. Hint: "Quarter-Kelly on each idea's shrunk edge, from its own history". | `Equal weight`          |
| **Dividends**               | **Reinvest in the stock** (default): a long position's dividend buys more of that stock at the ex-date close, at no cost, as the evaluator's total returns assume. **Keep in cash**: the dividend stays in cash until the next rebalance. Shorts pay their dividends from cash either way.                                                                                                                                                                                      | `Reinvest in the stock` |
| **Max per position (%)**    | Caps each name's weight in the book (long or short). Empty: no cap.                                                                                                                                                                                                                                                                                                                                                                                                             | `5`                     |
| **Max per sector (%)**      | Caps each sector's weight.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `30`                    |
| **Gross limit (×)**         | Maximum gross exposure, 0.1 to 3. Default 1.                                                                                                                                                                                                                                                                                                                                                                                                                                    | `1`                     |
| **Net limit (×)**           | Maximum net exposure, 0 to 3. Empty: none.                                                                                                                                                                                                                                                                                                                                                                                                                                      | (empty)                 |

Caps are applied to the whole book, across ideas. Shorts never use names on the hard-to-borrow list (set in YAML or
the API with `hardToBorrow`, or by `securities.hard_to_borrow: true` in the data).

#### Exits

The line above the fields reads: "A name always leaves when a rebalance replaces it. These add daily exits,
decided at a close and filled at the next one." (Strictly, the fill comes **Fill lag** sessions later; the
default lag is 1.)

| Field                                                                             | What it does                                                                                                                                          | Example |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **Stop loss (%)**                                                                 | Exit a position once its own return (price, dividends, costs and borrow) falls to −X%. Empty: none.                                                   | `15`    |
| **Take profit**                                                                   | **None**, **P90 of closed trades** (exit at the 90th percentile of the idea's trades closed so far, once it has 20 of them), or **A fixed return**.   | `None`  |
| **Take profit at (%)**                                                            | Shown for **A fixed return**. Defaults to 25%.                                                                                                        | `25`    |
| **Exit after the idea's horizon without a rebalance keeping the name**            | Exit a name after the plugin's `META.horizon_days` sessions if no rebalance has kept it.                                                              | off     |
| **Use the plugin's review() exits (invalidation, p_outperform), when it has one** | Each day, call the plugin's optional `review(ctx, held)`; it can flag held names to exit with reason `invalidation` or `p_outperform`. On by default. | on      |

A name that exits is not bought back until a signal dated after the exit. If a rebalance sells a name before its
exit fills, the sale carries the exit's reason.

#### Costs and seed (collapsed)

Open **Costs and seed** to override the evaluator's costs. An empty field uses the default from
`pipeline/config/backtest.yaml`, shown as the placeholder.

| Field                   | What it does                                                                              | Default |
| ----------------------- | ----------------------------------------------------------------------------------------- | ------- |
| **Commission (bps)**    | Commission on traded value.                                                               | 1       |
| **Slippage (bps)**      | Slippage on traded value.                                                                 | 5       |
| **Borrow (bps / yr)**   | Annual borrow fee on short value, charged daily.                                          | 50      |
| **Fill lag (sessions)** | Sessions between an exit decision and its fill (1 to 5).                                  | 1       |
| **Seed**                | Part of the config and of the ledger hash. The same config and seed give the same ledger. | 0       |

The delisting return (−30% by default) is not on the form; it comes from `backtest.yaml`. Costs follow the
evaluator's rule: commission plus slippage on the traded value, with targets sized on the NAV after costs.

#### Scope

There is no scope field on the form. The scope (which stocks the ideas may trade) is set when the config is saved:

1. If the config names `symbols` (tickers or security ids) or `universeTop` (the N largest US stocks by market cap
   on each date), that is used. You can set these in YAML or through the API.
2. Otherwise, the research settings' scope: the top-N by market cap (500 = the S&P 500 proxy), or the evaluation
   symbols.
3. Otherwise, the whole universe.

The estimate line and the run's **Config** tab show the result.

#### The estimate and Launch

The box at the bottom shows, for example: "About **3 min** · 2,262 sessions · code T-12 v3, T-15 v2 · the 500
largest by market cap on each date". Before any idea is picked it reads "Pick at least one idea."; while it works,
"Estimating…". A problem (an idea without code, a missing weight, an idea picked twice) appears in red under it.

How the estimate works: the sessions are the weekdays in the period. The time per session comes from this
workspace's last 10 successful simulations (time per session per idea, median). If there are none, it comes from
each idea's last 5 evaluations; failing that, 10 ms per session. About 6 seconds of job start-up is added.

**Launch** is enabled once there is an estimate, at least one idea, and the period is allowed. It saves the
config, freezes it into a new run and opens the run's page. **Cancel** closes the form.

What "pinned" means: each idea's plugin version is set to its latest version that **passed its test** (or its
current version if none passed). A re-run or a re-import therefore runs the same code. A cloned config keeps the
versions it already has; to move an idea to newer code, untick it and tick it again in the form.

### A run's page

The header shows the breadcrumb (**Simulations** › name), the status, the period, the capital, a chip per idea
("T-12 · low_vol_quality v3", which opens the idea), "uses the holdout" if so, and when it was created.

| Button              | What it does                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Clone and edit**  | (Administrators) Opens the form with this run's config, named "… (copy)".                                          |
| **Export YAML**     | Downloads `simulation-<id>.yaml`: the `SimulationConfig` and the `SimulationRun` record.                           |
| **Go live (paper)** | Disabled: "Paper trading of approved strategies comes in M7".                                                      |
| **Delete**          | (Administrators, not while running) Asks "Delete "…" and its ledger?" and removes the run and all its ledger rows. |

**While it runs**, a panel shows "Running · 1 min of about 3 min" and a progress bar based on the estimate. The
page refreshes every 3 seconds.

**If it failed**, a red notice shows the error type, the idea it failed in ("… in T-12"), the message, and, for an
error in the plugin's code, one line per stack frame ("line 14 in signal: …"). For a crashed job it shows the end of
the job's error output instead. Common messages:

- "The simulation did not finish in time": the run passed its 1-hour limit (plus a grace period).
- "Interrupted by a server restart; run it again": the API restarted while the run was going.

**When it succeeded**, six cards sit above the tabs:

| Card              | Value                  | Footnote                                  |
| ----------------- | ---------------------- | ----------------------------------------- |
| **CAGR**          | Compound annual growth | S&P 500 total return over the same period |
| **Sharpe**        | Annualised Sharpe      | Sortino                                   |
| **Max drawdown**  | Worst peak-to-trough   | Calmar (CAGR ÷ max drawdown)              |
| **Excess / year** | CAGR over the S&P 500  | IR (information ratio)                    |
| **Final NAV**     | Last day's NAV         | "from" the starting capital               |
| **Trades**        | Number of round trips  | share of winners, PF (profit factor)      |

### Performance tab

- **Equity**: "Growth of 1 after costs, borrow and dividends, against the S&P 500". Two lines, _Strategy_ and
  _S&P 500_, with a log-scale toggle.
- **Drawdown**: "From the running peak".
- **Exposure**: "Share of NAV: long, short (negative) and cash".
- **Rolling Sharpe**: over 126 sessions.
- **Monthly returns**: a heatmap of months by years, "Blue gains, red losses (%)".

The time-series charts are linked as one group (`group="sim"`), so they share the time axis as you zoom.

Under the charts is the ledger check, for example: "Ledger checks: NAV = cash + positions to within 1.2e-9, and
each day's change in NAV = price P&L + dividends − costs − borrow to within 3.4e-9. Costs paid $41,220, dividends
$188,034, borrow $0; turnover 4.1× a year." These two numbers are the largest error of each identity over all days.
Anything much above 1e-6 means the ledger is wrong.

### Trades tab

The blotter: one row per round trip. The tab label shows the count.

| Filter / column        | What it does                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Idea** filter        | **All ideas**, or one idea.                                                                                                                                                                               |
| **Exit reason** filter | **Any exit**, or one of: replaced, stop, take profit, horizon, invalidated, p < 0.5, delisted, no price, still open.                                                                                      |
| **Side** filter        | **Long and short**, **Long**, **Short**.                                                                                                                                                                  |
| Security search        | Placeholder "Ticker or SEC_…": an exact ticker or security id.                                                                                                                                            |
| **Sort**               | **Most recent exit**, **Oldest entry**, **Best P&L**, **Worst P&L**, **Best return**.                                                                                                                     |
| Columns                | **#**, **Security**, **Idea**, **Side**, **Entry**, **Exit**, **Sessions**, **Return**, **P&L**, **Exit reason** (a coloured pill). Up to 5,000 trades load; the count shows on the right ("412 trades"). |

**Exit reasons** in plain words:

| Pill                | Code           | Meaning                                                                     |
| ------------------- | -------------- | --------------------------------------------------------------------------- |
| replaced            | `replaced`     | A rebalance dropped the name.                                               |
| resized             | `rebalance`    | A rebalance changed the size (on fills).                                    |
| stop                | `stop`         | Hit the stop loss.                                                          |
| take profit         | `take_profit`  | Hit the take-profit level.                                                  |
| horizon             | `horizon`      | Held for the idea's horizon with no rebalance keeping it.                   |
| invalidated         | `invalidation` | The plugin's `review()` said the reason for holding is gone.                |
| p < 0.5             | `p_outperform` | `review()` judged the chance of outperforming to be under one half.         |
| delisted            | `delisted`     | The company stopped trading; closed at last price × (1 + delisting return). |
| no price            | `no_price`     | No price at a rebalance, so sold at the last close.                         |
| still open          | `open`         | Still held at the end; marked to market.                                    |
| entry               | `entry`        | (On fills) The buy that opened the position.                                |
| dividend reinvested | `dividend`     | (On fills) A dividend bought more shares.                                   |

#### A trade's drawer (its fills and its signal)

Click a row to open **Trade 7 · AAPL (T-12)**:

- The exit pill, side, entry → exit dates and sessions held.
- **Return**, **P&L**, **Dividends**, **Costs**, **Borrow**, **Entry → exit price**.
- **Why it was bought**: "On 2019-03-29 the idea's signal scored it **0.8312**, rank **4** of 487 eligible
  names." with links to **The idea's debate** and **its code**. This is the signal that opened the trade, stored
  with the order.
- **Price**: the close from 45 days before entry to 20 days after exit, with the held period highlighted. If the
  data has no closes, it shows a total-return index instead and says so.
- **Fills**: every fill of this trade: **Date**, **Side**, **Shares**, **Price**, **Notional**, **Cost**,
  **Reason** (entry, resized, dividend reinvested, the exit reason).

There is no separate Orders tab. The full list of fills, each with the signal (date, score, rank of N) that led to
it, is in the API: `GET /api/simulations/<id>/orders?idea=T-12&security=AAPL&date=2019-03-29`.

### Positions tab

The book as of any session. Drag the **As of** slider or pick a date (a date without a session moves to the next
session). The line above the table shows NAV, cash, gross, net, the number of positions and the day's return.

Columns: **Security**, **Idea**, **Sector**, **Shares**, **Price**, **Value**, **Weight**, **Unrealized P&L**,
**Since** (entry date). Rows are sorted by value. A day with nothing held shows "Flat on … : all cash."

### Attribution tab

Horizontal bar charts of P&L in USD, each counting closed and open trades:

- **P&L by idea**, **P&L by sector**, **P&L by side**, **P&L by exit reason**.
- **P&L by holding period**: ≤ 1 week (5 sessions), ≤ 1 month (21), ≤ 3 months (63), ≤ 6 months (126),
  ≤ 1 year (252), > 1 year.

**Calibration** asks "Do higher-ranked names do better?" It groups trades by the signal's rank at entry, in
fifths of the eligible names (**Q1** = the top fifth), with **Trades**, **Mean return** and **Winners**. A good
signal shows Q1 > Q2 > … > Q5. "No trade has a recorded signal rank." appears when the plugin's signal carried no
ranks.

### Config tab

The frozen inputs, in words: **Ideas** (with plugin, version and custom weight), **Period**, **Scope** (for example
"the 500 largest US stocks by market cap on each date (S&P 500 proxy)"), **Capital**, **Allocation**, **Sizing**,
**Constraints**, **Exits**, **Costs** ("the evaluator defaults (backtest.yaml)" when none were set), **Dividends**,
**Seed**, **Ledger hash**, **Simulator** (simulator and evaluator versions) and **Ran** (actual time and the
estimate). **Clone and edit** is repeated here.

### The parity check with evaluations

There is no parity button in the studio. Parity is a property of how the simulator is built, and it is what makes
a simulation trustworthy:

- Each idea's target books come from the evaluator's own signal walk (`engine.plan_books`). The simulator does not
  re-implement the strategy.
- With the defaults (**Equal** allocation, **Equal weight** sizing, dividends reinvested, no extra exits, so a
  name only leaves when a rebalance replaces it), a **one-idea simulation reproduces the evaluation's equity
  curve**: long-only books to 1e-9, books with shorts to about 1e-4 (the evaluator normalises weights before
  borrow).
- **Keep in cash** leaves a small, real gap (on live data 2e-4 to 5e-4 of equity over a year), because the
  dividend misses the stock's moves until the next rebalance.

To verify it yourself: simulate one idea with the defaults over the same period and scope as one of its
evaluations, then compare the CAGR, Sharpe and equity chart with the evaluation's. They should agree to the
rounding shown. The automated version is `test_one_idea_reproduces_the_evaluator_long` in
`pipeline/tests/test_paper_broker.py`.

### How a simulation works underneath

1. **Save.** The config is validated, each idea's plugin version is pinned, the scope is resolved, and the config
   is saved by name (collection `simulation_configs`).
2. **Freeze and start.** A run document is created with the frozen config, the estimate and `usesHoldout`. The
   Python job `pipeline.strategy.job` (action `simulate`) is started in the executor with a 1-hour limit.
3. **Each trading session**, the broker:
   1. charges borrow on yesterday's short value, applies splits (share counts) and dividends (cash, or reinvested),
      and marks every name to the close; a name that stopped trading and is no longer active is delisted;
   2. fills exits decided earlier, at today's close;
   3. trades each idea that rebalances today to its target weights (after allocation, sizing and caps), at today's
      close;
   4. writes the day's portfolio row and positions.
4. **Reconcile.** Every day must satisfy NAV = cash + market value, and change in NAV = price P&L + dividends −
   costs − borrow. The largest errors are reported.
5. **Store.** The ledger goes to four collections in the workspace database, keyed by `simulation_id`:
   `sim_orders` (fills), `sim_trades` (round trips), `sim_portfolio_daily` (one row per session) and
   `sim_positions` (one row per session, idea and name). The summary, series, monthly returns and attribution are
   stored on the run. A `ledger_hash` covers the whole ledger, so the same config and seed give the same hash.

Prices come from `prices_daily` (`close`, `ret_1d`, `tr_1d`). The day's split ratio and dividend are recovered
exactly as the prices transform computed them, so the ledger follows the same total returns as the evaluator.

### Scheduling

"Schedule" in the code means _launch_: the form is called the schedule modal, and **Launch** starts the run at
once. There is no calendar or recurring schedule for simulations, and the research loop never starts one.

There is no way in this build to run a simulation on a timer. Recurring runs would come with the live paper book
in M7.

### Simulations as YAML

- **`SimulationConfig`** is configuration: the definition by name, with ideas as `T-n` plus plugin name and
  version. It round-trips, and it is part of the git config backup (`simulation-configs.yaml`).
- **`SimulationRun`** is a record: the config by value, the status and the result (summary, series, attribution).
  It is restored as it was and never re-run. Runs are immutable: importing a different run with the same name is
  an error. The ledger rows are not exported; re-running the config rebuilds them identically (same hash).

See [Everything as YAML](#everything-as-yaml) for an example.

### Simulations API

| Method and path                            | What it does                                                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/simulations/estimate`           | The resolved config (pinned versions, scope) and the estimate; starts nothing.                                                   |
| `POST /api/simulations` (admin)            | Save the config and start a run (202 with the id and estimate).                                                                  |
| `GET /api/simulations`                     | The runs, newest first.                                                                                                          |
| `GET /api/simulations/configs`             | The saved configs.                                                                                                               |
| `GET /api/simulations/:id`                 | The run: frozen config, status, result.                                                                                          |
| `GET /api/simulations/:id/series?metric=`  | One series: `equity`, `nav`, `drawdown`, `rolling_sharpe_126`, `gross`, `net`, `long`, `short`, `cash`, `returns`, `spx_equity`. |
| `GET /api/simulations/:id/trades`          | The blotter (`idea`, `reason`, `side`, `security`, `sort`, `limit`, `offset`).                                                   |
| `GET /api/simulations/:id/trades/:n`       | One trade with its fills and prices.                                                                                             |
| `GET /api/simulations/:id/orders`          | The fills (`idea`, `security`, `date`).                                                                                          |
| `GET /api/simulations/:id/positions?date=` | The book at the last session on or before `date`.                                                                                |
| `GET /api/simulations/:id/export`          | The run and its config as YAML.                                                                                                  |
| `DELETE /api/simulations/:id` (admin)      | The run and its ledger.                                                                                                          |

### How-tos

#### Simulate two promising ideas together with risk parity

1. Open **Ideas**, open the first idea (say T-12, verdict promising) and press **Simulate**. The form opens with
   T-12 ticked.
2. In **Ideas**, also tick T-15. The name becomes "T-12 + T-15 simulation"; rename it if you like.
3. Under **Period**, press **10y**. Leave **Allow the holdout** off.
4. Under **Book**, set **Allocation across ideas** to **Risk parity**. Leave **Sizing** on **Equal weight (as
   evaluated)** so each idea trades as it was evaluated.
5. Optionally set **Max per position (%)** to `5` so one name can't dominate the combined book.
6. Check the estimate line: the sessions, the pinned code ("code T-12 v3, T-15 v2") and the scope.
7. Press **Launch**. The run's page opens with a progress bar.
8. When it finishes, compare **Sharpe** and **Max drawdown** with each idea's own evaluation. Open
   **Attribution → P&L by idea** to see what each idea contributed, and **Exposure** to see how the cash and gross
   moved.

#### Check whether a stop loss helps

1. Open a finished simulation and press **Clone and edit**.
2. Rename it (for example "… stop 15%"), set **Stop loss (%)** to `15`, and **Launch**.
3. Compare the two runs' cards. On the new run, filter **Trades** by **Exit reason: stop** and sort by **Worst
   P&L** to see what the stop cut, and look at **Attribution → P&L by exit reason**.

#### Find out why a trade was made

1. Open the run's **Trades** tab and type the ticker into "Ticker or SEC_…".
2. Click the trade. **Why it was bought** shows the signal's date, score and rank. Use **The idea's debate** and
   **its code** to see the reasoning and the code that produced the score.

#### Reproduce a run elsewhere

1. On the run's page press **Export YAML**.
2. On the other workspace, make sure the ideas (theories) and their strategy plugins exist, for example by importing
   them first (see [Everything as YAML](#everything-as-yaml)).
3. Import the file. The run comes back as a record; to rebuild its ledger, open it, **Clone and edit**, and
   **Launch**. With the same data, the ledger hash will match.

---

## Inbox

### Purpose

Some agent steps need a person. An agent can **ask a question** (its `ask_human` tool), a tool call can need
**approval** before it runs, and a harness **review** step can ask you to approve (and edit) a result. The run
pauses in the state `waiting_for_human`, frees its worker, and waits for you. The Inbox is where you answer.

In StockHarness this comes up, for example, when an agent has **Allow questions** on, when an agent is set to
"Ask a human to approve the code before each run" for its Python, or when **Tool approvals** is set to ask for
risky tools.

### How to get there

Sidebar: **Inbox** (URL `/inbox`). The sidebar label shows the number of pending requests you can answer, for
example **Inbox (2)**; it refreshes every 5 seconds. Questions and approvals also appear inline in the Playground.

### What you see

The title **Inbox (n)** and the line "Questions and actions awaiting your decision. Approvals authorize an action;
its execution trace records the outcome." Under it, **Show tasks**: **Pending**, **Resolved**, **Cancelled** or
**All tasks**. The list refreshes every 3 seconds. With nothing pending: "No pending requests."

Each request is a card:

| Element                                   | What it does                                                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heading                                   | **Your input is needed** (a question) or **Review before continuing** (an approval or a review).                                                                                                      |
| Prompt                                    | The question, or what is being approved.                                                                                                                                                              |
| "Run … · Expires …"                       | The run id and when the request times out.                                                                                                                                                            |
| Email notice                              | If email notification is on: "Email notification sent.", "Email notification queued.", or "Email delivery failed: … Check Settings → Email. Delivery will retry automatically." with **Retry email**. |
| Tool name                                 | For approvals, the tool to be called, for example `run_python`.                                                                                                                                       |
| **Tool arguments**                        | (Approvals) The call's arguments as JSON. You may edit them before approving; the edited call must still match the tool's schema.                                                                     |
| **Answer** / **Edited result (optional)** | (Questions / reviews) Your answer, up to 32,000 characters. For a review, an optional edited result.                                                                                                  |
| **Feedback (optional)**                   | A note returned to the agent with your decision (up to 4,000 characters).                                                                                                                             |
| **Execution context**                     | Opens the run's last 12 trace events, so you can see what led to the request.                                                                                                                         |
| **Send answer** / **Approve**             | Sends the decision. **Send answer** needs some text.                                                                                                                                                  |
| **Deny**                                  | Refuses. The agent receives the denial and your feedback, and a denied tool is not called.                                                                                                            |

Resolved cards show "Decision: approve" (or answer, deny), the prompt, your answer or feedback, and the run id.
Cancelled ones show "Request cancelled".

### How it works

- **Who may answer.** By default administrators and the run's owner (the creator of the harness or agent,
  recorded when the run starts). The API can add specific users. You only see requests you may answer.
- **Timeouts.** A request expires after the agent's **Approval timeout (minutes)** (default 24 hours; 1 minute to
  7 days). Then the **Timeout action** applies: **Deny** (default; the agent is told input is missing),
  **Continue without new input** (a review step proceeds with its original result) or **Escalate to
  administrators** (one more timeout period for admins, then deny). A tool approval is never approved
  automatically.
- **Resuming.** Your answer goes back through the durable run queue. The run continues where it stopped, even after
  a restart, without repeating tool calls it had finished.
- **Cancelling** a run (on Executions) closes its pending requests, including those of child runs.
- **Limits.** One run can raise at most 100 requests; after that the agent is told to summarise what it has.
- **Records.** Each decision records who decided (or `timeout`), when, the arguments and the feedback. If the agent
  has a notebook, the decision is also saved there as a decision note.

### Configuring it (agent settings)

In a harness, open an agent's settings:

| Field                                                                 | What it does                                                                                                                         | Example               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| **Human input** → **Allow questions**                                 | Gives the agent the `ask_human` tool. Hint: "The agent can pause to ask a question. Answer it in the Inbox or Playground."           | on                    |
| **Python code** → **Ask a human to approve the code before each run** | Every `run_python` call needs your approval in the Inbox.                                                                            | off                   |
| **Tool approvals**                                                    | **No approval required**, **Ask for risky tools** (tools without a read-only annotation count as risky), **Ask for every MCP tool**. | `Ask for risky tools` |
| **Approval timeout (minutes)**                                        | How long a request waits.                                                                                                            | `1440`                |
| **Timeout action**                                                    | **Deny**, **Continue without new input**, **Escalate to administrators**.                                                            | `Deny`                |
| **Email authorized approvers**                                        | Sends approvers an email with a signed link (needs Settings → Email (SMTP)). The link still needs you to sign in.                    | off                   |

Per-tool rules and specific approver lists can be set through the API (see `docs/human-input.md`).

### How-to: answer an agent's question

1. When the sidebar shows **Inbox (1)**, open it.
2. Read the prompt. Open **Execution context** if you need to see what the agent was doing.
3. Type your answer in **Answer**, add **Feedback (optional)** if useful, and press **Send answer**.
4. The card disappears from **Pending**. The run continues; follow it on **Executions**.

### How-to: approve a Python job with a change

1. Open the request. **Tool arguments** shows the code and parameters the agent wants to run.
2. Edit the JSON if needed (for example lower a `limit`), then press **Approve**. Or press **Deny** with a reason in
   **Feedback (optional)** so the agent can propose something else.

---

## Executions

### Purpose

Every run of a harness or an agent: from the Playground, the API, webhooks, embeds, schedules (including the
research loop's cycles) and sub-agents. Use it to watch runs, read their trace, cancel them and find out why one
failed. Simulations and evaluations are executor jobs, not runs, and do not appear here.

### How to get there

Sidebar: **Executions** (URL `/executions`). `/executions?cycle=<id>` lists only the runs started by one machine
monitoring cycle.

### What you see

The title **Executions**, then status chips with counts: **All**, **Running**, **Queued**, **Waiting for a
person**, **Succeeded**, **Failed**, **Interrupted**, **Cancelled**. The chips filter the page that is loaded (50
runs, newest first); use **Previous** / **Next** to page. The list refreshes every 3 seconds.

| Column      | What it shows                                                                            | Example                    |
| ----------- | ---------------------------------------------------------------------------------------- | -------------------------- |
| **Harness** | The harness or agent name, and the first 8 characters of the run id.                     | `Research loop` `3f9a1c2b` |
| **Status**  | The status; "resumed 2×" if a runner died and the run was restarted from its checkpoint. | `running`                  |
| **Input**   | The input text, truncated.                                                               | `Research cycle (run now)` |
| **Trigger** | `studio`, `api`, `chat`, `webhook`, `embed`, `schedule` or `subagent`.                   | `schedule`                 |
| **Started** | When the run was created.                                                                |                            |
| **Inspect** | Opens the run.                                                                           |                            |

With no runs: "No runs yet" and "Runs from the playground, API, webhooks and schedules show here."

### A run's detail

**Inspect** opens a wide dialog titled with the harness name. It refreshes every 2 seconds.

- The status and the full run id.
- **Cancel run** (red), for runs that are queued, running or waiting for a person.
- **Input**: what the run was given.
- **Streaming**: the answer as it is written, while it runs.
- **Output**: the final answer.
- The error, in red, if there is one.
- **Execution trace**: one line per event, with its message, type and node, and the time. Click an event to see
  its data as JSON.

Common event types: `node started` / `node completed` (a harness step), `model request` / `model response`,
`model retry`, `tool started`, `tool error`, `tool uncertain`, `context compacted`, `context retry`,
`budget exhausted`, `loop limit`, `skill loaded`, `memory written`, `plan`, `reflection`, `resumed`,
`interrupted`, `email sent`.

### Statuses

| Status                   | Meaning                                                                                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Queued**               | Waiting for a runner.                                                                                                                                                                                                                                |
| **Running**              | A runner is working on it.                                                                                                                                                                                                                           |
| **Waiting for a person** | Paused on an Inbox request (`waiting_for_human`). It holds no worker.                                                                                                                                                                                |
| **Succeeded**            | Finished with an output.                                                                                                                                                                                                                             |
| **Failed**               | Stopped with an error.                                                                                                                                                                                                                               |
| **Interrupted**          | Its runner died and the run could not safely be restarted. The error says why, for example "Runner interrupted and not resumed because the agent can call external tools, which may already have acted. Review the trace before starting a new run." |
| **Cancelled**            | Cancelled by a person (or with its parent run).                                                                                                                                                                                                      |

When a runner dies, the run is either **resumed** from its last checkpoint (shown as "resumed n×") or marked
**interrupted**. It resumes when that is safe: no step had started, the step in flight has no external side
effects, or the harness's resume policy says "always". There is a cap on automatic resumes.

**Cancelling.** A queued or waiting run is cancelled at once, together with its waiting child runs and pending
Inbox requests. A running run is flagged and stops at its next step boundary, so it may take a moment to show
**Cancelled**.

**Too many runs.** If the workspace already has the maximum number of active runs (queued, running or waiting), a
new one is refused with "Too many active runs. Wait for a run to finish."

### How-to: find out why a run failed

1. Open **Executions** and press the **Failed** chip (or **Interrupted**).
2. **Inspect** the run. Read the red error first.
3. Scroll the **Execution trace** to the end and work backwards. Look for `tool error`, `model retry`,
   `budget exhausted`, `loop limit` or `context retry` events. Click one to see its data (the tool's arguments and
   error, or the model's status).
4. Typical causes and fixes:
   - "Model provider returned HTTP 4xx …": the model provider is wrong or out of quota. Test it on **Settings →
     Model providers** (see the [Vertex AI example](#worked-example-gemini-on-vertex-ai)).
   - `budget exhausted` / `loop limit`: the agent ran out of tokens or turns. Raise the agent's budget or narrow the
     task.
   - A `tool error` from a connection: check the connection on **MCP connections**.
   - **Interrupted**: the runner died mid-step. Read the trace to see whether the external action happened, then
     start a new run.
5. If the run was waiting for a long time and then failed, check the **Inbox** with **Show tasks: All tasks** for
   a request that timed out.

---

## Integrations

### Purpose

Ways for other systems to use your harnesses: API keys, the API explorer, webhooks and an embeddable chat.

### How to get there

Sidebar: **Integrations** (URL `/integrations`). Four cards across the top choose the section; **API key** is open
first.

| Card              | Text                                              | Steps shown                                                                      |
| ----------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| **API explorer**  | "Explore the Open Harness API and send requests." | Choose a harness · Edit the request · Inspect the response                       |
| **API key**       | "Run a harness from your own code."               | Create a key for one harness · POST /api/runs · Poll or stream the run           |
| **Webhook**       | "Another system posts JSON to start a harness."   | Create a webhook · POST JSON with its secret · Poll the run with the same secret |
| **Embedded chat** | "A chat with one harness on your website."        | Create an embed for your site's origin · Paste the iframe · Revoke any time      |

### API key

A table of keys (**Name**, **Target**, **Expires**, **Revoke**) and **Create API key**.

| Field                 | What it does                                                                                                                                                                        | Example              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **Name**              | A label.                                                                                                                                                                            | `Nightly report job` |
| **Harness**           | The one harness or saved agent the key may run and read. Administrators also see **Whole workspace · Open Harness API**, a workspace-wide key (`oh_sk_…`) for the Open Harness API. | `Research loop`      |
| **Expires in (days)** | 1 to 365.                                                                                                                                                                           | `7`                  |

After **Create API key**, "Your API key is ready" shows the key once: "Copy this now. The secret is only shown
once." The page also shows copyable `curl` examples for **Run** (`POST /api/runs` with an `Idempotency-Key`),
**Chat and stream** (`POST /api/chat`, then `GET /api/runs/RUN_ID/stream`) and **Open Harness API**. **Revoke**
asks for confirmation; existing clients lose access.

### API explorer

Titled **Open Harness API**: "Browse the API, edit a request, and inspect its response. Requests act on your real
workspace." A link downloads **OpenAPI JSON**.

- **Harness**: which harness the requests target (or **Legacy workspace alias**).
- **API key (optional)**: leave empty to use your signed-in session, or paste a key to test with its permissions.
- The left side: **Search endpoints…** and a domain filter (**All domains · n operations**), then the list of
  operations.
- The right side: the method and path, summary and description, a notice if "This operation is not implemented.",
  **Support details**, one field per parameter (`name * · in`), the **Request body** (pre-filled from the schema),
  **Request schema**, then **Send GET/POST…**, **Stop** and **Copy cURL**, and the **Response** with its status and
  **Response schema**. WebSocket operations show how to connect instead of a send button.

Be careful: requests act on your real workspace.

### Webhook

**Webhooks**: "Another system posts JSON; a run starts." A table (**Name**, **Endpoint** with a copy button,
**Expires**, **Revoke**) and **Create webhook**.

| Field                | What it does                                                                                                                   | Example          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| **Webhook name**     | A label.                                                                                                                       | `Earnings alert` |
| **Target**           | The harness or saved agent to run.                                                                                             |                  |
| **Input JSON field** | Which field of the posted JSON becomes the run's input, for example `input`, `message` or `event.text`. Blank: the whole body. | `input`          |
| **Expires in days**  | 1 to 365. Default 30.                                                                                                          |                  |

"Webhook ready" shows the **Endpoint** and the **Webhook secret** once. Post JSON with the secret as a bearer token;
harness steps can read `{{payload.field}}`. Poll `GET /api/hooks/:id/runs/:runId` with the same secret for the result.

### Embedded chat

**Embeds**: a table and **Create embed**, with **Name**, **Harness**, **Allowed website origins** (comma-separated,
for example `https://example.com, http://localhost:3000`, no trailing slash) and **Expires in (days)** (1 to 30).
"Your embed is ready" shows the `<iframe …>` to paste, once. Visitors see only the conversation; the link works from
the allowed origins until it expires or you revoke it.

### How-to: start a harness from a script

1. **Integrations → API key → Create API key**. Name it, pick the harness, choose the expiry, and copy the key.
2. Copy the **Run** example and replace `YOUR_API_KEY` and the input.
3. The call returns a run `id`. Poll `GET /api/runs/:id` or stream `GET /api/runs/:id/stream`. The run also
   appears on **Executions** with trigger `api`.

---

## Settings

### How to get there

Sidebar: **Settings** (URL `/settings`), or click your name at the bottom of the sidebar. `/settings#email` opens
the email tab. The tabs are **Model providers**, **Email (SMTP)**, **My profile**, **Python secrets**,
**Configuration (YAML)** and, for administrators, **Team & workspace**.

### Model providers

A **model provider** is one model at one endpoint with its key: for example "Gemini 3.8 Flash on Vertex". Agents
choose a provider; new agents start with the workspace default. The tab reads "New agents start with the default
provider. Each agent can pick another."

Each provider row shows its name (click to edit), its base URL, and tags: **Default**, the kind
(OpenAI-compatible, Anthropic, Google Gemini, Ollama), "LLM · model" (or Vision, Embedding), **Encrypted key** or
**No API key**, and **Streaming off** if streaming is disabled.

| Control          | What it does                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add provider** | Opens **Add a model provider**.                                                                                                                                                                |
| **Test**         | Sends "Reply with the word Connected." with the saved settings. Shows **Connected** and "Replied: "Connected"", or **Test failed** with the error. Embedding providers report the vector size. |
| **Make default** | (Administrators; chat and vision providers only) Makes this the workspace default.                                                                                                             |
| Settings icon    | Edit.                                                                                                                                                                                          |
| Bin icon         | Delete, after "Delete model provider "…"?".                                                                                                                                                    |

#### The provider form

**Provider** section: pick a preset card. It fills in the kind and base URL and suggests model ids.

| Preset                         | Kind              | Base URL                                                 | Suggested models                                                            |
| ------------------------------ | ----------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| **OpenAI**                     | OpenAI-compatible | `https://api.openai.com/v1`                              | gpt-4.1, gpt-4.1-mini, gpt-4o, gpt-4o-mini, o3-mini                         |
| **Anthropic**                  | Anthropic         | `https://api.anthropic.com/v1`                           | claude-sonnet-5, claude-opus-5-5, … (no embeddings)                         |
| **Google Gemini**              | Google Gemini     | `https://generativelanguage.googleapis.com/v1beta`       | gemini-2.5-pro, gemini-2.5-flash, gemini-2.0-flash                          |
| **Google Gemini on Vertex AI** | Google Gemini     | `https://aiplatform.googleapis.com/v1/publishers/google` | gemini-3.8-flash, gemini-4-argon; gemini-embedding-001                      |
| **Ollama (local)**             | Ollama            | `http://host.docker.internal:11434`                      | llama3.1, qwen2.5, mistral, gemma3                                          |
| **Other OpenAI-compatible**    | OpenAI-compatible | `https://your-endpoint.example/v1`                       | (none: vLLM, LM Studio, Azure OpenAI, DeepSeek, Mistral, Groq, OpenRouter…) |

The **Google Gemini** preset is Google AI Studio (keys from AI Studio). **Google Gemini on Vertex AI** is Google
Cloud's Vertex AI with an express-mode key. They use different keys and different URLs; see the
[worked example](#worked-example-gemini-on-vertex-ai).

| Field                                  | What it does                                                                                                                                                                                            | Example                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Provider name**                      | The name agents and YAML refer to. Keep names stable: exported objects reference providers by name.                                                                                                     | `Gemini-flash-3-8`                                       |
| **API base URL**                       | The endpoint. The model path is appended to it.                                                                                                                                                         | `https://aiplatform.googleapis.com/v1/publishers/google` |
| **API key**                            | Stored encrypted; never shown again. When editing: "A key is saved. Leave this field untouched to keep it."                                                                                             | `AQ.Ab8R…`                                               |
| **Model type**                         | **LLM · text and reasoning**, **Vision · images and text**, or **Embedding · notebook search** (not for Anthropic). One model per entry.                                                                | `LLM`                                                    |
| **Model ID**                           | "Any model your provider offers." The preset's models are suggested as you type.                                                                                                                        | `gemini-3.8-flash`                                       |
| **Advanced → Maximum output tokens**   | The initial allowance per response, including reasoning (128 to 32,768; default 4,096). "Recovery can raise it up to 32,768 tokens within the agent's total job budget and the model's context window." | `8192`                                                   |
| **Advanced → Context window (tokens)** | Prompt plus output capacity (2,048 to 4,000,000; default 128,000). If the provider reports a smaller limit in an error, the stored value is lowered automatically. Raise it after a server upgrade.     | `1000000`                                                |
| **Advanced → Output budget field**     | (OpenAI-compatible only) `max_tokens` or `max_completion_tokens`. "Some reasoning models require max_completion_tokens."                                                                                | `max_tokens`                                             |
| **Advanced → Stream answers**          | Streams the answer as it is written. "Turn off for servers that reject the stream flag."                                                                                                                | on                                                       |

**Test connection** ("Checks the models before you save.") runs the same test on the unsaved form, reusing the saved
key when editing. It shows **Chat model** "Replied: "…"" or the error, and for embedding models **Embedding model**
"Vectors of 768 dimensions". A vision model is tested with a small blue image ("What color is this image?").
Tests are rate-limited. **Save provider** saves.

The Advanced section is hidden for embedding models.

#### How it works

- Each call goes to _base URL_ + the kind's path. For the Google Gemini kind: `…/models/<model>:generateContent`,
  or `…/models/<model>:streamGenerateContent?alt=sse` when streaming, with the key in the `x-goog-api-key` header.
  Embeddings use `…/models/<model>:embedContent`.
- Busy or flaky responses (HTTP 408, 409, 425, 429, 500, 502, 503, 504, and dropped connections) are retried, up to
  4 attempts. Other errors are reported at once as "Model provider returned HTTP <status>: <message>. <hint>". The
  hint is either a specific fix (see the worked example) or "Check the endpoint, model, credentials and quota."
- Every call also tells the model its configured model id, so it reports its identity correctly.

#### Choosing a provider for an agent

In the harness editor and the harness starter, the **Model provider** field lists chat and vision providers as
"name · model" ("· default" on the default). Under it, **Add model provider** opens the same form, and **Edit
selected provider** edits the chosen one. The research settings name their models by provider name.

#### How-to: add a model provider and test it

1. **Settings → Model providers → Add provider**.
2. Pick a preset card, for example **Google Gemini on Vertex AI**.
3. Give it a clear **Provider name**, paste the **API key**, and choose the **Model ID**.
4. Open **Advanced** and set **Context window (tokens)** to the model's real window (for example `1000000`) and
   **Maximum output tokens** as needed.
5. Press **Test connection**. Wait for **Chat model** with "Replied: …". If it fails, read the hint in the message.
6. Press **Save provider**. If this should be the default for new agents, press **Make default** on its row.
7. Press **Test** on the row to confirm the saved version works too.

### Email (SMTP)

**Outgoing email**: "Used by Email steps in harnesses." It is also used for Inbox email notifications. A pill
shows where the settings come from: **workspace settings**, **from .env** or **not configured**.

| Field / control                                    | What it does                                                                                                                                                                                                                                                                      | Example                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Provider cards                                     | **Amazon SES**, **Google Workspace**, **SendGrid**, **Mailgun**, **Postmark**, **Other SMTP server**. A card fills in host, port and TLS and shows a hint (for example SES: "Use SMTP credentials from the SES console (not your AWS keys) and replace the region in the host."). | `Amazon SES`                         |
| **SMTP host**                                      | The server.                                                                                                                                                                                                                                                                       | `email-smtp.us-east-1.amazonaws.com` |
| **Port**                                           | Usually 587.                                                                                                                                                                                                                                                                      | `587`                                |
| **Username**                                       | "Leave empty for relays that do not authenticate."                                                                                                                                                                                                                                |                                      |
| **Password**                                       | Stored encrypted. "A password is saved. Leave blank to keep it."                                                                                                                                                                                                                  |                                      |
| **From address**                                   | A sender your provider has verified.                                                                                                                                                                                                                                              | `StockHarness <reports@example.com>` |
| **Implicit TLS (port 465)**                        | "Off for STARTTLS on port 587, which is what most providers use."                                                                                                                                                                                                                 | off                                  |
| **Outgoing email enabled**                         | "When off, Email steps fail with a clear message instead of sending."                                                                                                                                                                                                             | on                                   |
| **Save email settings**                            | Saves (administrators only).                                                                                                                                                                                                                                                      |                                      |
| **Use .env defaults instead**                      | Removes the workspace settings and falls back to `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`.                                                                                                                                                             |                                      |
| **Send a test email** → **Send to**, **Send test** | Sends a test with the saved settings ("save first"). Shows **Sent** "Accepted for …" or **Not sent** with the error.                                                                                                                                                              | `you@example.com`                    |

Members can see the settings but only administrators can change them.

### My profile

Your name and email, your role and "Local account". **Change password**: "Enter your current password to change
your email or password." **New password**: "At least 12 characters. Leave blank to keep your current password."
**Save profile** (shows "Profile saved").

### Python secrets

"API keys and passwords that Python code needs, for example `FMP_API_KEY`." A Python step (a transform, a harness
code step) or an agent that runs Python gets **only the secrets it lists**, as environment variables
(`os.environ["FMP_API_KEY"]`). Values are stored encrypted and never shown again.

The list shows each secret's name, its source ("From FMP (apikey)", "From … (token)" or "Entered value") and when
it was updated. Administrators can delete one ("Steps and agents that list it will fail until it is added again.")
and add one:

| Field              | What it does                                                                                              | Example       |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ------------- |
| **Name**           | Upper-case letters, digits and `_` (up to 64).                                                            | `FMP_API_KEY` |
| **Source**         | **Copy from an MCP connection** (default) or **Enter a value**.                                           |               |
| **MCP connection** | The connection whose key to copy.                                                                         | `FMP`         |
| **URL parameter**  | The query parameter in the connection's URL that holds the key; empty uses the connection's access token. | `apikey`      |
| **Value**          | (Enter a value) The secret itself.                                                                        |               |
| **Save secret**    | Saves it.                                                                                                 |               |

Objects reference secrets by name only (for example a transform's `secrets: [FMP_API_KEY]`), which is why YAML
exports never contain secret values. In an agent's settings, **Secrets for the code** takes the names,
comma-separated.

### Configuration (YAML)

**Configuration as YAML**: every object in the workspace exports as `stockharness/v1` YAML and imports back, here or
on another install. **Export YAML** downloads everything; **Import YAML** opens the import dialog. Under them is the
**Backup to git** card. Both are described in [Everything as YAML](#everything-as-yaml).

The help text on the page mentions dataset syncs, harnesses, agents and skills; the export actually contains all
14 kinds, including research records (theories, evaluations, simulation runs).

### Team & workspace (administrators)

A **workspace** (tenant) is the shared space a team works in. Members of a workspace share harnesses, knowledge,
providers, connections, data, ideas and simulations. Each account belongs to one workspace; the box at the top of
the sidebar shows its name and "Shared workspace".

- **Workspace name** and **Save workspace name**.
- **Accounts**: **Name** ("(you)" on yours), **Email**, **Role** (`admin` or `member`), **Status** (enabled or
  disabled), and for others **Disable** / **Enable** and **Reset password** (at least 12 characters). Disabling or
  resetting signs the person out everywhere.
- **Add teammate**: **Name**, **Email**, **Password** (at least 12 characters) and **Role** (**Member** or
  **Administrator**), then **Create teammate**.

What only administrators can do (among others): start and delete simulations, import YAML, change email
settings, add or delete Python secrets, make a provider the default, create a workspace-wide API key, and manage
accounts.

The API (`POST /api/users` with `"workspace": "new"`) can also create an account in a brand-new, empty workspace,
with that account as its administrator. The studio's **Add teammate** form does not offer this option; use the API
(for example from Integrations → API explorer).

### Guardrails

Guardrails (safety policies run by NeMo Guardrails or the built-in checker) do not have a page in this build's
sidebar. They appear in the harness editor: a **NeMo Guardrail** box attached to an agent's top port, with a
**Guardrail policy** field. Workspace-wide default policies are stored on the workspace (`PUT /api/tenant` with
`guardrailIds`). Exports reference policies by name and never include them; an import needs a matching enabled
policy on the target.

`docs/guardrails.md` describes a **Guardrails** page (policy templates, **Try it out**, recent decisions). That page
is not in the StockHarness sidebar: guardrails are set per agent in the harness editor.

### Related components outside Settings

- **Task memory** (Playground, **Memory** panel): the notes the run's agents shared, with **Search notes** /
  **Search / refresh**, **More notes**, paging through a note, and **Keep in long-term memory** (with **Save to
  notebook** when there are several). Temporary notes expire after seven days.
- **Conversation export** (Playground header): **Copy conversation**, **Download Markdown**, **Print / Save as PDF**,
  and **Print options** (**Portrait** or **Landscape (wide tables)**).

---

## Everything as YAML

### Purpose

Everything StockHarness manages is a YAML object: configuration, code, policies and records. You can export any of
it, keep it in git, review a change as a diff, and import it into another workspace or install. Nothing that holds
a secret is ever in the file.

### The envelope

Every object is one YAML document with four keys:

- `apiVersion: stockharness/v1`
- `kind`: one of the kinds below
- `metadata`: `name` (and for some kinds a `version`)
- `spec`: the definition or record

A file holds many objects as multi-document YAML (separated by `---`), sorted by kind, then name. There are no ids,
timestamps, server state or other volatile fields, so a re-export of unchanged objects gives the same bytes and
git diffs stay small.

### The kinds

Kinds are listed in import order: a later kind can refer to an earlier one.

| Kind                 | What it is                                                                       | Re-import behaviour                                            |
| -------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Skill**            | An agent skill: instructions verbatim.                                           | Create or update by name.                                      |
| **Agent**            | An agent: prompt, provider, connections and tools, settings.                     | Create or update by name.                                      |
| **Harness**          | A harness (workflow): nodes, including Python code steps verbatim.               | Create or update by name.                                      |
| **DatasetSync**      | A Layer 1 data sync: connection by name, schedule, Python.                       | Create or update by name.                                      |
| **Transform**        | A Layer 2 transform: its Python verbatim, inputs, outputs, secret names.         | Create or update; history restored for new transforms.         |
| **CatalogEntry**     | The curated description of a collection and its fields.                          | Merge.                                                         |
| **Pipeline**         | A Layer 2 pipeline of transforms.                                                | Create or update by name.                                      |
| **StrategyPlugin**   | An idea's strategy code verbatim, with its hash (checked on import) and version. | Create or update; history restored for new plugins.            |
| **Evaluation**       | An evaluation record: provenance, parameters, result.                            | Record: never re-run; immutable (a different one is an error). |
| **Gates**            | A version of the success gates (`metadata.name: v3`).                            | Same thresholds = unchanged; a taken number gets the next one. |
| **ResearchSettings** | The research loop's settings (one per workspace), models and skills by name.     | Merge.                                                         |
| **Theory**           | An idea with its debate.                                                         | Record: never re-run; never overwritten.                       |
| **SimulationConfig** | A saved simulation definition.                                                   | Create or update by name.                                      |
| **SimulationRun**    | A simulation's record: config by value, status, result.                          | Record: never re-run; immutable.                               |

### The rules

- **References by name.** A reference to another object is written as
  `{ $ref: { type: providers, name: Gemini-flash-3-8 } }`. Ideas in a simulation are `T-n`; plugins are a name and a
  version; dataset syncs name their connection.
- **No secrets.** Connections, model providers, knowledge bases and guardrail policies are never exported, because
  they hold secrets. Create them on the target first, with the same names. Python secrets appear only by name
  (`secrets: [FMP_API_KEY]`).
- **Code verbatim.** Python, prompts and skill instructions are YAML block scalars (`code: |`), byte for byte.
- **No data rows.** Synced data and the simulation ledger are not in the file. Back data up with MongoDB; re-run a
  simulation config to rebuild its ledger.
- **Round trip.** Each kind is tested by exporting it, importing it into an empty isolated stack, exporting again,
  and checking the YAML is identical.

### Example: a simulation config

This is what **Export YAML** writes for a saved simulation config (names and numbers here are illustrative):

```yaml
# StockHarness objects (apiVersion stockharness/v1). Import from Settings -> Configuration or the
# object list pages. References are by name; secrets and data rows are never included.
apiVersion: stockharness/v1
kind: SimulationConfig
metadata:
  name: Momentum + low vol, RP
spec:
  description: ''
  ideas:
    - idea: T-12
      plugin: low_vol_quality
      version: 3
    - idea: T-15
      plugin: mom_12_1
      version: 2
  period:
    start: 2015-05-11
    end: 2025-05-09
    allowHoldout: false
  universeTop: 500
  capital: 1000000
  benchmark: spx
  allocation: risk_parity
  sizing:
    mode: equal
    kellyFraction: 0.25
  constraints:
    positionCap: 0.05
    sectorCap: null
    gross: 1
    net: null
  exits:
    stop: null
    takeProfit: null
    horizon: false
    review: true
  costs: {}
  hardToBorrow: []
  dividends: reinvest
  seed: 0
```

`costs: {}` means "the evaluator defaults". To override, write for example
`costs: { commissionBps: 1, slippageBps: 5, borrowBps: 50, executionLagDays: 1 }`. For custom allocation, add
`allocation: custom` and a `weight` (0 to 1) to every idea. Instead of `universeTop` you can give
`symbols: [AAPL, MSFT, …]`.

And an agent, showing references by name (from `deploy/config-io/exports/agents.yaml`, shortened):

```yaml
apiVersion: stockharness/v1
kind: Agent
metadata:
  name: M3 Coder check
spec:
  systemPrompt: You write and fix strategy plugins with the research data tools. …
  providerId:
    $ref:
      type: providers
      name: Gemini-flash-3-8
  connections:
    - connectionId:
        $ref:
          type: connections
          name: Research data
      tools:
        - describe_collection
        - test_strategy
        - evaluate_strategy
        - get_evaluation
  maxTurns: 16
  timeoutSeconds: 300
  enabled: true
```

### Where to export and import

- **Settings → Configuration (YAML)**: **Export YAML** (all objects, file `stockharness-all-<date>.yaml`) and
  **Import YAML**.
- Per page, compact **Export** / **Import** buttons for one kind: Harnesses, Skills, Datasets → Transforms,
  Datasets → Pipelines (and one pipeline), one transform, one evaluation.
- **Export YAML** on an idea's page (the theory) and on a simulation's page (config and run).
- The command line: `deploy/config-io/config_io.py` (`export`, `export --with-history`, `apply --dry-run`,
  `apply`, `apply --replace`).
- The API: `GET /api/objects/export?kinds=SimulationConfig,Theory&names=…`, `POST /api/objects/import`,
  `GET /api/objects/kinds`.

Anyone signed in can export. Only administrators can import.

### The import dialog

Titled **Import … from YAML**.

| Field / control         | What it does                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **YAML file**           | Choose a file: "A StockHarness export, a Datasets YAML export, or a deploy/config-io file."                                                                  |
| **Or paste YAML**       | Paste the text instead.                                                                                                                                      |
| **Mode**                | **Merge: create new objects, update ones with the same name**, or **Replace: also remove objects of these kinds that are not in the file**.                  |
| **Kind of a bare list** | "Only for config-io files that are a plain list": **Auto (stockharness/v1 objects)**, **Skills**, **Agents**, **Harnesses**, **Dataset syncs**.              |
| **Preview**             | A dry run: nothing is written. It lists **Errors** ("fix these first, nothing is applied"), **Create**, **Update**, **Remove** and "Unchanged: n".           |
| **Apply import**        | Enabled only after a preview with no errors. It applies exactly what was previewed (editing anything clears the preview). Red when the plan removes objects. |

Objects are matched by kind and name. References must already exist on the target or be created by the same file;
a missing one is reported as, for example, `providers "Gemini-flash-3-8" (create it on this install first)`.
Replace mode removes only kinds that appear in the file (agents, skills, harnesses, dataset syncs, transforms,
pipelines, strategy plugins); records are never removed. Objects still referenced elsewhere are not removed.

The import is all-or-nothing on preview errors. If something fails while applying, the dialog says "Stopped: …
(applied before it: n)": the objects written before the failure stay.

### Backup to git

The **Backup to git** card shows whether the workspace configuration is backed up to a GitHub repository. Every few
minutes (5 by default) the app renders one file per kind (`skills.yaml`, `agents.yaml`, `harnesses.yaml`,
`dataset-syncs.yaml`, `transforms.yaml`, `catalog.yaml`, `pipelines.yaml`, `strategy-plugins.yaml`,
`research-gates.yaml`, `research-settings.yaml`, `simulation-configs.yaml`). When they changed it commits them to
the `config-backup` branch under `deploy/config-io/exports/` and keeps one "Config snapshot" pull request into
`main` open. Merge that PR to make `main` the recovery point; it is never merged automatically. Records (theories,
evaluations, simulation runs) are not part of the backup.

| Element               | Meaning                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| Status pill and label | **not connected**, **failed**, **in sync with main**, or **snapshot PR open**. |
| **Last checked**      | The last time it looked for changes.                                           |
| **Last change**       | The last time the configuration changed.                                       |
| **Last commit**       | The commit (linked) and its time.                                              |
| **Snapshot PR**       | The open pull request.                                                         |
| **Objects**           | Counts per kind.                                                               |
| **Back up now**       | (Administrators) Runs the backup at once.                                      |

"Not connected" means changes are detected but not pushed: `CONFIG_BACKUP_REPO` and a GitHub token
(`CONFIG_BACKUP_GITHUB_TOKEN` in the `openharness-config-backup` secret) are needed. A notice appears when `main` has
been behind the live configuration for more than a day.

### How-to: export the research setup as YAML and import it into a new workspace

1. **On the source workspace**: **Settings → Configuration (YAML) → Export YAML**. You get
   `stockharness-all-<date>.yaml` with every object. (To move only the research setup, export kinds one by one from
   their pages, or use the API with `kinds=Transform,Pipeline,StrategyPlugin,Gates,ResearchSettings,Agent,Skill,Harness`.)
2. **List what the file needs**: search it for `$ref` and `connection:`. Note the provider, connection and
   knowledge base names, and every name under `secrets:`.
3. **On the target workspace**, sign in as an administrator and create those first, with exactly the same names:
   - **Settings → Model providers**: the providers (for example `Gemini-flash-3-8`), with their keys. Test them.
   - **MCP connections**: the connections (for example `FMP`, `Research data`, the MongoDB connection).
   - **Knowledge**: any knowledge bases.
   - **Settings → Python secrets**: each secret name (for example `FMP_API_KEY`).
4. **Settings → Configuration (YAML) → Import YAML**. Choose the file. Leave **Mode** on **Merge**.
5. Press **Preview**. Fix every error it lists (most often a missing reference), and preview again.
6. Check the **Create** list, then press **Apply import**.
7. Data rows did not come with the file. Run the dataset syncs and pipelines on the target to fill the data. The
   theories, evaluations and simulation runs come back as records, as they were.
8. Optional: export again from the target and compare the file with the original. For the configuration kinds it
   should be identical.

---

## Worked example: Gemini on Vertex AI

This deployment uses Google's Gemini models through **Vertex AI** (Google Cloud), not through Google AI Studio.
The two use different keys and different URLs, and mixing them up gives confusing errors. Here is the correct
setup.

### What you need

- A **Vertex AI express-mode API key**. It **starts with `AQ.`**. (A Google AI Studio key starts differently and
  belongs with the **Google Gemini** preset, not this one.)
- For preview models: your Google Cloud **project number** (or id).

### A regular model: gemini-3.8-flash

1. **Settings → Model providers → Add provider**.
2. Pick **Google Gemini on Vertex AI**. The form fills in:
   - kind: Google Gemini
   - **API base URL**: `https://aiplatform.googleapis.com/v1/publishers/google`
3. **Provider name**: for example `Gemini-flash-3-8`.
4. **API key**: paste the `AQ.…` key.
5. **Model type**: **LLM · text and reasoning**. **Model ID**: `gemini-3.8-flash`.
6. **Advanced**: set **Context window (tokens)** to the model's window (for example `1000000`) and **Maximum output
   tokens** (for example `8192`). Leave **Stream answers** on.
7. **Test connection** should show **Chat model** "Replied: "Connected"". Then **Save provider**.

Requests then go to
`https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse`
with the key in the `x-goog-api-key` header.

### A preview model: gemini-4-argon

Preview models are often served only in the **global** location of your project. Use the project-scoped base URL:

```
https://aiplatform.googleapis.com/v1/projects/<project number>/locations/global/publishers/google
```

1. Add another provider with the **Google Gemini on Vertex AI** preset (one model per provider).
2. **Provider name**: for example `Gemini-4-argon`.
3. **API base URL**: replace the default with the global URL above, for example
   `https://aiplatform.googleapis.com/v1/projects/123456789012/locations/global/publishers/google`.
4. **API key**: the same `AQ.…` key. **Model ID**: `gemini-4-argon`.
5. **Test connection**, then **Save provider**.

The preset card's hint says the same: "Preview models (for example gemini-4-argon) are often served only in the
global location: then use https://aiplatform.googleapis.com/v1/projects/<project>/locations/global/publishers/google."

### The two errors and what they mean

StockHarness recognises both and adds the fix to the message (`providerHint` in `packages/core/src/llm.ts`). The
messages below are abridged: Google's own wording varies, and StockHarness keeps up to 500 characters of it. The
last sentence of each is StockHarness's hint, word for word.

**403 `API_KEY_SERVICE_BLOCKED`**

```
Model provider returned HTTP 403: Requests to this API generativelanguage.googleapis.com … are blocked.
This key may not call the Gemini API (generativelanguage.googleapis.com); a Vertex AI key needs a Vertex base URL:
https://aiplatform.googleapis.com/v1/publishers/google (or …/v1/projects/<project>/locations/global/publishers/google
for preview models).
```

Meaning: a Vertex express-mode key (`AQ.…`) was sent to the AI Studio Gemini API
(`generativelanguage.googleapis.com`), usually because the provider was created with the **Google Gemini** preset.
The key is fine; the URL is wrong. Fix: edit the provider, pick **Google Gemini on Vertex AI** (or type the Vertex
base URL), leave the key field untouched to keep the saved key, **Test connection**, **Save provider**. The hint
appears only for a 403 that mentions `generativelanguage.googleapis.com` and says `API_KEY_SERVICE_BLOCKED` or
"are blocked".

**404 "Publisher model … not found"**

```
Model provider returned HTTP 404: Publisher model `projects/123456789012/locations/us-central1/publishers/google/models/gemini-4-argon`
was not found or your project does not have access to it. … The model gemini-4-argon is not served in us-central1.
Preview models are often only in the global location: set the provider's base URL to
https://aiplatform.googleapis.com/v1/projects/123456789012/locations/global/publishers/google.
```

Meaning: the model is not served in the location the request reached (here `us-central1`). This is typical for
preview models when the base URL has no location (the short `…/v1/publishers/google` form) or a regional one. The
hint takes the project number from Google's own error message, so you can copy the suggested URL as it is. Fix: set
the provider's **API base URL** to that global URL and test again.

If the 404 already names `locations/global`, StockHarness gives no hint: the model id is wrong, or your project has
no access to it. Check the exact model id and your access in the Google Cloud console.

Neither error is retried (only busy or flaky responses are), so it shows up at once in **Test connection**, in a run's
error on **Executions**, and in the agent's trace.

Embeddings (`gemini-embedding-001`, offered by the preset) through Vertex express mode have not been tested in this
deployment. Use **Test connection** with **Model type: Embedding · notebook search** to confirm before relying on
them.

---

# Glossary

| Term                         | Meaning                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent**                    | A model with instructions, tools and skills that does one job in a harness (the Theorist, the Judge, the Coder…).                                                                                                                                 |
| **Alpha t**                  | The t-statistic of the return left over after removing market, momentum, value, quality and low-volatility exposure (Newey-West). About 2 means roughly 95% confidence that the strategy adds something beyond known factors. A gate: at least 2. |
| **As-of date / known at**    | When a row became known. Every read is cut at the date being simulated, so a strategy never sees later data.                                                                                                                                      |
| **Backfill**                 | Fetching history for a sync over a past date range, in chunks, beside the regular schedule.                                                                                                                                                       |
| **Catalog (Schema Catalog)** | The description of every collection: fields, examples, caveats and its known-at rule.                                                                                                                                                             |
| **Claim**                    | A Coder's hold on the idea it is working on. It expires after 2 hours, so another cycle can take the idea over.                                                                                                                                   |
| **Coder**                    | The research role that turns an approved idea into a strategy plugin, tests it and evaluates it.                                                                                                                                                  |
| **Cycle**                    | One run of the research loop: the Theorists, the pre-code Judge, the Coder, then the post-result Judge.                                                                                                                                           |
| **Deflated Sharpe**          | The probability that the Sharpe ratio beats what the luckiest of all the workspace's trials would show by chance. A gate: at least 0.95.                                                                                                          |
| **Evaluation**               | One run of the trusted evaluator: a plugin version over a window and scope. It produces a record (metrics, series, per-name results) and counts as one trial.                                                                                     |
| **Excess (vs the S&P 500)**  | Return per year above the S&P 500. Note: the benchmark is the index price return, without dividends (#363).                                                                                                                                       |
| **Gate**                     | A fixed threshold that a verdict is checked against (Sharpe, deflated Sharpe, positive excess years, alpha t, trades, holdings, warnings, holdout). Gates are versioned, and a version locks at its first verdict.                                |
| **Harness**                  | A workflow of agents and steps, drawn on the Harnesses canvas. The research loop is a harness.                                                                                                                                                    |
| **Holdout**                  | The last 18 months of data, locked away from research. Each idea version gets one run on it, at its verdict.                                                                                                                                      |
| **Idea / theory**            | A trading hypothesis with its debate, code, evaluations and verdict. The two words are used interchangeably; it is shown as T-_n_.                                                                                                                |
| **Idea profile**             | What an idea trades: equity long, short or long/short, or an options structure (options are not yet testable).                                                                                                                                    |
| **Judge**                    | The research role that reviews ideas before code (approve, revise, reject) and gives the verdict after results.                                                                                                                                   |
| **Layer 1**                  | Raw data synced from providers (FMP).                                                                                                                                                                                                             |
| **Layer 2**                  | Clean point-in-time tables made from Layer 1 by Python transforms.                                                                                                                                                                                |
| **MCP**                      | Model Context Protocol: how agents reach tools. Every external tool is an MCP connection.                                                                                                                                                         |
| **Name subset**              | The names of the scope a strategy works best on, picked on the first two thirds of the window and checked on the rest against random sets ("Names it works for").                                                                                 |
| **Plugin (strategy plugin)** | The Python code of an idea: `META` and `signal(ctx)`, optionally `universe(ctx)` and `review(ctx, held)`. It is versioned, and each version is pinned by its hash.                                                                                |
| **Point in time**            | Using only data known on the date being simulated.                                                                                                                                                                                                |
| **Promising**                | A verdict: the idea beat the S&P 500 and failed only the proof gates (deflated Sharpe, alpha t). It worked, but it isn't proven.                                                                                                                  |
| **S&P 500 proxy**            | The 500 largest US stocks by market cap on each date (point in time, delisted names included). The FMP plan has no constituents list.                                                                                                             |
| **Sharpe ratio**             | Mean daily return divided by the standard deviation of daily returns, × √252, after costs. A gate: at least 0.5.                                                                                                                                  |
| **Simulation**               | A paper portfolio of one or more ideas, traded by the paper broker with sizing, exits and costs. A person starts it.                                                                                                                              |
| **Skill**                    | A versioned instruction document an agent can load (for example `write-a-strategy-plugin`).                                                                                                                                                       |
| **Successful**               | A verdict: every gate passed, including the holdout.                                                                                                                                                                                              |
| **Sync**                     | A scheduled job that copies one provider dataset into a Layer 1 collection.                                                                                                                                                                       |
| **Theorist**                 | The research role that proposes new ideas (or revises one sent back).                                                                                                                                                                             |
| **Transform**                | Python code that builds Layer 2 collections. It runs after its inputs change.                                                                                                                                                                     |
| **Trial**                    | One evaluation. The workspace counts all of them, and the deflated Sharpe uses that count.                                                                                                                                                        |
| **Verdict**                  | successful, promising or failed. It is set by the gates; the Judge can downgrade a passing idea but never upgrade a failing one.                                                                                                                  |
