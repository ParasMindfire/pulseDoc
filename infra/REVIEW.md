# Reviewing `infra/main.bicep` before you run it

Read this before running anything — either locally or via the new GitHub Actions
workflow. Bicep deploys are not sandboxed: if a name is wrong, it doesn't
politely fail, it creates a brand-new resource next to your real one, or edits
the wrong thing. This file is split into three parts:

1. **How it gets triggered** (the GitHub Actions side, same mechanics as your other two workflows)
2. **Line-by-line**, what every block of `main.bicep` actually does
3. **The verification checklist** — the specific names/credentials you must confirm before the first real deploy

---

## 1. How it gets triggered

You already have two workflows that deploy *code*:

| Workflow | Triggers on | Deploys |
|---|---|---|
| `main_func-pulsedoc-processdoc-dev-cin.yml` | any push to `main` | Function App **code** |
| `main_app-pulsedoc-web-dev-cin-001.yml` | any push to `main` | Web App **code** |
| `infra-deploy.yml` (new) | push to `main` that touches `infra/**`, or manual | the **shell** those two apps run in — Key Vault secrets, App Insights, the plans, RBAC, the Logic App |

Mechanically it's the identical pattern as your existing two:

```yaml
on:
  push:
    branches: [main]
    paths: ['infra/**']   # <- the one difference: only fires when infra/ changes
  workflow_dispatch:        # <- manual "Run workflow" button in the Actions tab
```

then a job with `permissions: id-token: write` that runs `azure/login@v2` using
**OIDC** (no stored password — GitHub proves its identity to Azure AD via a
short-lived token, Azure AD checks it against a federated credential you set
up once). That's exactly what your other two workflows already do — the only
difference is *which* Azure identity logs in (see the checklist below, this
is the part you must set up before this workflow can succeed).

Two jobs, in order:
- **`what-if`** — runs `az deployment group what-if`, a dry run. Shows what
  *would* change, changes nothing. Always runs.
- **`deploy`** — only starts if `what-if` succeeded (`needs: what-if`), then
  runs the real `az deployment group create`. It also targets a GitHub
  **Environment** called `production` — if you go to your repo's
  *Settings → Environments → production* and add a **required reviewer**,
  GitHub will pause this job and wait for a human click before it actually
  touches Azure, even on an automatic push trigger. Recommended while you're
  still trusting this file. Optional if you'd rather it just run.

You can watch it run the same way you watch your other two: repo → **Actions** tab.

---

## 2. Line-by-line — what `main.bicep` does

### Header comment block
Explains scope and, importantly, the **appSettings-is-a-full-replace** gotcha
(see checklist item 5 below) — read that comment in the file itself, it's not
repeated in full here.

### `targetScope = 'resourceGroup'`
Says "I deploy resources *into* a resource group," as opposed to
`subscription` (used for things like creating the resource group itself,
which this file does not do). Every `az deployment group ...` command below
implicitly targets whatever `--resource-group` you pass on the command line.

### `param` block
Four inputs. `env`, `regionCode`, `location` have defaults — you'll basically
never override them. `dbAdminPassword` and `geminiApiKey` are `@secure()`
**with no default**, on purpose: Bicep will refuse to deploy without them
being explicitly supplied, so there's no way to accidentally deploy with an
empty secret.

### `var` block
Builds every resource name from your naming table (`README_PULSEDOC.md`) via
string interpolation, so e.g. `kvName` always equals `kv-pulsedoc-dev-cin`
given `env='dev'`, `regionCode='cin'`. One name here is **new**, not from your
table: `funcPlanName = asp-pulsedoc-func-dev-cin` — your table never named the
Function App's hosting plan because the portal auto-names Consumption plans
for you. This file gives it an explicit name instead. **Check this doesn't
collide with anything** (see checklist item 3).

`keyVaultSecretsUserRoleId` is a fixed GUID Microsoft assigns to the built-in
**"Key Vault Secrets User"** role — same GUID in every Azure subscription
worldwide, it identifies the *role definition*, not a specific grant of it.

### `resource kv ... existing = { name: kvName }`
A **read-only reference**, not a creation. `existing` tells Bicep "this
already exists, just let me point at it." If no Key Vault named `kvName`
exists in the target resource group, the deploy fails immediately at this
point with a clear "not found" error — which is a *safe* failure (nothing
gets created wrong), just make sure `kvName` is actually right first.

### The six `secretXxx` resources
Each writes one value into Key Vault as a child of `kv` (`parent: kv` is what
makes it a child resource rather than a new top-level thing). Re-running the
deploy with the same secret name just adds a new *version* of that secret —
Key Vault keeps history, nothing is destroyed. Note `secret-pulsedoc-logicapp-url`
is **not** here — same chicken/egg your manual guide already documents,
because the Logic App's real URL doesn't exist until after this same deploy
finishes. You still update that one secret by hand afterward.

### `appInsights`
One resource, shared by both apps, `kind: 'web'`. Nothing unusual.

### `funcStorage`, `funcPlan`, `functionApp`
- `funcStorage` — the storage account a Function App needs internally (not
  your Postgres DB — completely separate concern).
- `funcPlan` — `sku: { name: 'Y1', tier: 'Dynamic' }` is what "Consumption"
  actually is under the hood.
- `functionApp` — `kind: 'functionapp'` marks it as a Function App;
  `identity: { type: 'SystemAssigned' }` is the Bicep equivalent of the
  portal's *Identity → System assigned → On* toggle from README Part 4;
  `serverFarmId: funcPlan.id` is what actually attaches it to that plan —
  referencing `.id` on another resource is also what tells Bicep the deploy
  order (`funcPlan` before `functionApp`) *without* you writing an explicit
  `dependsOn` anywhere.
  Inside `siteConfig.appSettings`: the first five are plain values; the last
  six are Key Vault references built from each secret's own
  `.properties.secretUri` — same string you'd have typed by hand into the
  portal, just impossible to typo here since it's derived, not retyped.

### `funcKvRole`
A **role assignment** — grants the Function App's own managed identity (not
you, not the pipeline — the *app itself*) permission to read Key Vault
secrets. `scope: kv` means this permission is scoped to just that vault, not
the whole subscription. The `name:` of a role assignment must be a GUID;
`guid(kv.id, functionApp.id, keyVaultSecretsUserRoleId)` deterministically
computes the *same* GUID every time for this exact (vault, app, role)
combination, which is what makes re-running this deploy safe — it updates the
same assignment instead of erroring "already exists" or creating a duplicate.

### `webPlan`, `webApp`, `webKvRole`
Same shapes as the Function App's three blocks, adapted for Linux (`kind:
'linux'`, `reserved: true` — required specifically for Linux plans),
`sku: F1/Free`, and `linuxFxVersion: 'NODE|22-lts'` +
`appCommandLine: 'npm start'` standing in for README Part 5's runtime-stack
dropdown and startup command field. `LOGIC_APP_URL` is absent from its
appSettings for the same chicken/egg reason as the Key Vault secret above.

### `logicApp`
`definition: loadJsonContent('../logic_app/workflow.json').definition` reads
your actual, real `logic_app/workflow.json` off disk at deploy time — so the
workflow logic has exactly one home in the repo. This file does not duplicate
or re-describe your Logic App's steps in Bicep syntax.

### `output` block
Values printed at the end of a successful deploy (and visible in the GitHub
Actions log). Nothing secret is output — contrast with `dbAdminPassword` /
`geminiApiKey`, which are `@secure()` and Azure structurally refuses to ever
print those, even if you tried to output them.

---

## 3. Verification checklist — do this before your first real deploy

Some of these you can check yourself without touching Azure at all; the rest
need one `az` command each.

### A. Things where a wrong value creates a DUPLICATE resource instead of updating your real one
Run each check, compare the output to the corresponding `var` in
`main.bicep`:

```bash
az login   # if you haven't already

# Does the resource group exist, in the region you expect?
az group show --name rg-pulsedoc-dev-cin --query location -o tsv

# Key Vault — must match `kvName` exactly (case-sensitive)
az keyvault show --name kv-pulsedoc-dev-cin --query name -o tsv

# Function App — must match `funcName`
az functionapp show --name func-pulsedoc-processdoc-dev-cin --resource-group rg-pulsedoc-dev-cin --query name -o tsv

# Web App — must match `webName`
az webapp show --name app-pulsedoc-web-dev-cin-001 --resource-group rg-pulsedoc-dev-cin --query name -o tsv

# Function App's storage account — must match `funcStorageName`
az storage account show --name stpulsedocfuncdevcin --query name -o tsv
```

If any of these errors with "not found," **stop** — either the name in
`main.bicep` is wrong, or that resource genuinely doesn't exist yet under
that name (check the portal directly to be sure which).

### B. `funcPlanName` — the one name this file invented
`asp-pulsedoc-func-dev-cin` isn't in your original naming table. Check
nothing already uses that exact name for something else:
```bash
az resource list --resource-group rg-pulsedoc-dev-cin --query "[?name=='asp-pulsedoc-func-dev-cin']"
```
Empty result (`[]`) is what you want. If your Function App's Consumption plan
already exists under an auto-generated name (portal-created Consumption plans
often get a GUID-ish or region-based name), this file will create a **second**
plan with the new name rather than adopt the old one — cosmetically messy
(one unused, un-billed-differently Consumption plan sitting around) but not
harmful. Delete the orphaned old one manually afterward if so, once you've
confirmed the Function App is happily running on the new named plan.

### C. `dbHost` — this file does NOT verify your Postgres server actually exists
`dbHost` is just a string built from a naming pattern
(`psql-pulsedoc-dev-cin.postgres.database.azure.com`) — it is **not** a
reference to a real resource, so a typo here won't fail loudly, it'll just
write a wrong hostname into the `secret-pulsedoc-db-host` Key Vault secret,
which then makes both apps fail to connect to the database after this
deploys. Verify:
```bash
az postgres flexible-server show --name psql-pulsedoc-dev-cin --resource-group rg-pulsedoc-dev-cin --query fullyQualifiedDomainName -o tsv
```
and confirm it matches the `dbHost` variable exactly.

### D. `dbAdminPassword` — must be the REAL existing password
This file does not create or change your PostgreSQL server, it only writes
whatever password you pass in as the value of the `secret-pulsedoc-db-password`
Key Vault secret. If you pass the wrong password, both apps will start
failing DB connections right after this deploys, with no error from Bicep
itself (it doesn't validate the password against the server — it can't, Bicep
has no relationship with Postgres auth). Confirm you're using the actual
saved password from when you created the server in README Part 2, not a
guess.

### E. `geminiApiKey` — same idea, lower stakes
Wrong key just breaks Gemini calls (visible immediately as `Failed` /
`Needs Review` documents with an auth-looking error message), not a silent
data-loss risk like C/D above. Still worth double-checking.

### F. **The big one — appSettings full-replace risk**
Before your *very first* deploy of the `functionApp` / `webApp` resources,
list what's actually live today and compare against the `appSettings` arrays
in `main.bicep`:
```bash
az functionapp config appsettings list --name func-pulsedoc-processdoc-dev-cin --resource-group rg-pulsedoc-dev-cin -o table
az webapp config appsettings list --name app-pulsedoc-web-dev-cin-001 --resource-group rg-pulsedoc-dev-cin -o table
```
If either list has entries `main.bicep` doesn't (Azure often silently adds
`WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` / `WEBSITE_CONTENTSHARE` to
Consumption Function Apps, for example), **add those into the corresponding
`appSettings` array in `main.bicep` before deploying**, or your first deploy
will remove them and can break the app. When in doubt, deploy `what-if` only,
read the `Modify` diff on these two resources line-by-line, and don't run the
real `deploy` job until you're sure nothing important is disappearing.

### G. Always run `what-if` first, and actually read it
Both locally and in CI (the `what-if` job runs automatically before `deploy`
in the new workflow). Locally:
```bash
az deployment group what-if \
  --resource-group rg-pulsedoc-dev-cin \
  --template-file infra/main.bicep \
  --parameters dbAdminPassword='<real password>' geminiApiKey='<real key>'
```
Read every line. `Create` on something you expected to already exist =
checklist item A/B above went wrong. Anything marked `Delete` on the Key
Vault, the Postgres-related secrets, or the apps themselves = stop
immediately, something is very wrong, do not proceed to `deploy`.

---

## One-time setup: the identity that runs `infra-deploy.yml`

This is the part that's genuinely new work, not just review. Your two
existing workflows' OIDC identities were auto-created by Azure's Deployment
Center flow, each scoped to exactly one app — neither can write a Key Vault
secret or create a role assignment. You need a third identity with
resource-group-scoped rights. Run these once, locally, logged in as yourself
(`az login`) with enough privilege to create app registrations and role
assignments in this subscription:

```bash
# 1. An Azure AD application to represent this pipeline
az ad app create --display-name "pulsedoc-infra-github-actions"
# note the "appId" from the JSON output -> call it APP_ID below

# 2. A service principal for that application (this is the identity that actually gets roles assigned)
az ad sp create --id <APP_ID>

# 3. Find your subscription ID
az account show --query id -o tsv
# -> SUBSCRIPTION_ID

# 4a. Grant it Contributor on just the resource group (create/update/delete resources)
az role assignment create \
  --assignee <APP_ID> \
  --role Contributor \
  --scope /subscriptions/<SUBSCRIPTION_ID>/resourceGroups/rg-pulsedoc-dev-cin

# 4b. Contributor alone CANNOT create role assignments (Azure excludes that
# from Contributor on purpose, for security) — but this file's funcKvRole
# and webKvRole resources need exactly that. Grant it explicitly too:
az role assignment create \
  --assignee <APP_ID> \
  --role "Role Based Access Control Administrator" \
  --scope /subscriptions/<SUBSCRIPTION_ID>/resourceGroups/rg-pulsedoc-dev-cin
# (Simpler alternative if you'd rather have one role instead of two: use
# "Owner" instead of Contributor + RBAC Administrator — Owner already
# includes both. Slightly less least-privilege, less to manage.)

# 4c. Contributor/Owner also doesn't grant Key Vault DATA access (reading/
# writing secrets) — that's a separate permission model. Grant it on the vault specifically:
az role assignment create \
  --assignee <APP_ID> \
  --role "Key Vault Secrets Officer" \
  --scope /subscriptions/<SUBSCRIPTION_ID>/resourceGroups/rg-pulsedoc-dev-cin/providers/Microsoft.KeyVault/vaults/kv-pulsedoc-dev-cin

# 5. Federated credential — this is what lets GitHub Actions log in with NO
# stored password, by presenting a token that Azure AD trusts because it
# came from this exact repo's main branch.
az ad app federated-credential create \
  --id <APP_ID> \
  --parameters '{
    "name": "pulsedoc-infra-main-branch",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:<your-github-username>/pulsedoc:ref:refs/heads/main",
    "audiences": ["api://AzureADTokenExchange"]
  }'
# Replace <your-github-username> with the actual owner of this repo on GitHub.
# This one credential covers BOTH the push trigger and workflow_dispatch,
# as long as you always run it against the main branch.

# 6. Get your tenant ID
az account show --query tenantId -o tsv
```

Then, in your GitHub repo → **Settings → Secrets and variables → Actions**,
add these (new — don't reuse the `AZUREAPPSERVICE_*` ones, they belong to the
other two workflows and don't have the rights this one needs):

| Secret name | Value |
|---|---|
| `AZURE_INFRA_CLIENT_ID` | the `APP_ID` from step 1 |
| `AZURE_INFRA_TENANT_ID` | output of step 6 |
| `AZURE_INFRA_SUBSCRIPTION_ID` | output of step 3 |
| `DB_ADMIN_PASSWORD` | your real PostgreSQL admin password |
| `GEMINI_API_KEY` | your real Gemini API key |
| `FUNCTION_APP_URL` | the real Function App URL incl. `?code=...` (see the "Secret-scanning incident" note below for why this exists as a separate secret) |

Once those six secrets exist, `infra-deploy.yml` can log in and run. Until
then it will fail on the `azure/login` step with an authentication error —
that's expected, not a bug in the workflow.

### RoleAssignmentExists on first real `deploy` run

The `funcKvRole`/`webKvRole` resources (granting "Key Vault Secrets User" to
each app's managed identity) failed on the actual `deploy` — not `what-if` —
with `RoleAssignmentExists`, pointing at two role assignment IDs that didn't
match the ones Bicep computed. Cause: both permissions were already granted
manually, back in README Parts 4-5. Azure enforces uniqueness on
`(principalId, roleDefinitionId, scope)`, not on the assignment's own
name/GUID — so a `guid(...)`-derived deterministic name doesn't help here,
it's still a duplicate grant of the same permission under the hood. Fix:
removed both resources from `main.bicep` entirely rather than fight it —
the permission already exists and works, there's nothing to adopt or manage.

### Secret-scanning incident, 2026-09-09 — why `functionAppUrl` is a param, not a file value

Early on, the real Function URL+key got pasted directly into
`logic_app/workflow.json` to fix the placeholder-URL blocker (see the first
finding below). That's committable-looking (it's just a JSON file) but it's
not safe — `main.bicep`'s `logicApp` resource loads that whole file verbatim
via `loadJsonContent()`, so anything in it ends up in the repo permanently.
GitHub's push protection caught it before it left your machine (`GH013:
Repository rule violations found ... Azure Function Key`) and rejected the
push outright.

Fix applied: `logic_app/workflow.json` now declares a `functionUrl`
**parameter** (with a harmless placeholder `defaultValue`, safe to commit)
and its `Call_Function` action references `@parameters('functionUrl')`
instead of a literal string. `main.bicep` injects the real value at deploy
time via a new `@secure() param functionAppUrl`, fed from the
`FUNCTION_APP_URL` GitHub secret — same treatment as `dbAdminPassword` /
`geminiApiKey`. The committed file can never contain the real secret again,
and the live Logic App still gets wired correctly on every deploy.

The exposed key from the incident was rotated immediately (Function App →
Functions → `process-document` → Function Keys → renew `default`) — treat
any key that ever touches a local commit (pushed or not) or a chat
transcript as burned, regardless of whether the push itself succeeded.

## Findings from the first real `what-if` run against this project

Running the checklist above for real turned up exactly the kind of issues it
warns about — recorded here so the reasoning isn't lost:

- **Blocker, fixed by editing `logic_app/workflow.json`, not Bicep**: the
  live Logic App has the real Function URL+key wired in, but the repo's
  `workflow.json` still had the placeholder text from before README Part 6
  was completed. Deploying as-was would have overwritten the working Logic
  App with a literal placeholder string and broken every upload. Always
  re-run `what-if` and check the `Microsoft.Logic/workflows` block
  specifically for this before ever running `deploy`.
- **Fixed in `main.bicep`**: Application Insights was declared as one new
  shared resource (`appi-pulsedoc-dev-cin`) per the original naming table,
  but reality (confirmed via `what-if`) is that each app already has its
  own auto-created component named after itself. Now adopted via `existing`
  instead of forking a third, disconnected one.
- **Fixed in `main.bicep`**: the Function App's Consumption plan is
  auto-named (`ASP-rgpulsedocdevcin-b035`, not the `asp-pulsedoc-func-dev-cin`
  this file originally invented). Plan names are immutable, so "renaming"
  would have meant migrating the app to a brand-new plan for no real benefit.
  Now adopted by its real name instead.
- **Decision made, fixed in `main.bicep`**: the live Web App plan is B1
  (Basic), not the F1 (Free) the original naming table called for —
  confirmed intentional, so the SKU was updated to match reality rather than
  silently downgrading it on deploy.
- **Still open / re-verify before `deploy`**: the `what-if` output did not
  show any explicit `appSettings` differences on either site resource — this
  is a known limitation of `what-if` for `Microsoft.Web/sites` (it doesn't
  reliably diff into that nested array), **not** confirmation that nothing
  will change. Checklist item F is still mandatory: run
  `az functionapp config appsettings list` /
  `az webapp config appsettings list` and manually diff against what's in
  `main.bicep` before your first real deploy, especially since this deploy
  will also point `AzureWebJobsStorage` at a **newly created** storage
  account (`stpulsedocfuncdevcin` didn't exist yet under that exact name) —
  confirm what storage account the Function App actually uses today
  (Function App → check the `AzureWebJobsStorage` setting's `AccountName=`)
  before deploying, in case it's a different one than expected.

- **Fixed in `main.bicep`, checklist item F materialized for real**: manually
  diffing `az functionapp config appsettings list` against the file (as
  instructed above) found 4 real, live settings missing from the Function
  App's `appSettings` array — `AzureWebJobsSecretStorageType`,
  `SCM_COMMAND_IDLE_TIMEOUT`, `WEBSITE_RUN_FROM_PACKAGE`,
  `WEBSITE_ENABLE_SYNC_UPDATE_SITE`. `WEBSITE_RUN_FROM_PACKAGE=1` in
  particular is very likely what makes the currently zip-deployed code
  actually run — deploying without it would have been the exact silent
  breakage this checklist item warned about. All 4 now added with their
  real live values.
- **Fixed in `main.bicep`, same pattern on the Web App side**: diffing
  `az webapp config appsettings list` found `LOGIC_APP_URL`,
  `ApplicationInsightsAgent_EXTENSION_VERSION`, and
  `XDT_MicrosoftApplicationInsights_Mode` missing. `LOGIC_APP_URL` was the
  serious one — it was live, already a proper Key Vault reference (not the
  plain-text fallback the README warns about), and completely absent from
  the file; deploying would have deleted the one setting that lets the Web
  App actually reach the Logic App. All 3 now added.

## Recommended order of operations

1. Do the "One-time setup" above.
2. Run the checklist in section 3 locally, fix anything that doesn't match.
3. Run `what-if` **locally** first (section 3.G) — read it carefully.
4. Push a trivial change under `infra/` (or use **Run workflow** /
   `workflow_dispatch` on the Actions tab) so the CI `what-if` job runs too —
   confirm it matches what you saw locally.
5. Only then let/approve the `deploy` job.
