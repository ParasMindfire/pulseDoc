# PulseDoc — Full Deployment Guide (Clean Rewrite, Proper Naming)

Project name: **PulseDoc** — a clinical document processing platform (BP + HbA1c extraction), built on Azure. This guide consolidates everything into one clean, correctly-named build, using the deployment methods that actually proved reliable: **Kudu** for the Function App (Windows-hosted), **Postman** for the Web App (Linux-hosted), then **GitHub Actions** layered on top once the core system works.

Your Gemini API key stays the same as before — no need to regenerate it.

---

## 0. Naming Convention (used consistently throughout)

Base pattern borrowed from standard Azure conventions: `{resource-prefix}-{app}-{purpose}-{env}-{region}`, lowercase, hyphen-separated, no consecutive hyphens, no leading/trailing hyphens.

| Variable | Value |
|---|---|
| App/project short name | `pulsedoc` |
| Environment | `dev` |
| Region code | `cin` (Central India) |

| Resource | Naming pattern | Actual name to use |
|---|---|---|
| Resource Group | `rg-{app}-{env}-{region}` | `rg-pulsedoc-dev-cin` |
| Web App | `app-{app}-web-{env}-{region}-{instance}` | `app-pulsedoc-web-dev-cin-001` |
| Web App's App Service Plan | `asp-{app}-web-{env}-{region}` | `asp-pulsedoc-web-dev-cin` |
| Function App | `func-{app}-{function-purpose}-{env}-{region}` | `func-pulsedoc-processdoc-dev-cin` |
| Function App's Storage Account | `st{app}func{env}{region}` (no hyphens allowed) | `stpulsedocfuncdevcin` |
| Logic App | `logic-{app}-{process}-{env}` | `logic-pulsedoc-processdocument-dev` |
| PostgreSQL Flexible Server | `psql-{app}-{env}-{region}` | `psql-pulsedoc-dev-cin` |
| Key Vault | `kv-{app}-{env}-{region}` | `kv-pulsedoc-dev-cin` |
| Key Vault secrets | `secret-{app}-{description}` | e.g. `secret-pulsedoc-db-host` |
| Application Insights (both apps) | `appi-{app}-{env}-{region}` | `appi-pulsedoc-dev-cin` |
| GitHub repo | same as app name | `pulsedoc` |

Note on storage account and Key Vault: these two resource types must be **globally unique across all of Azure**, not just your subscription. If a name is taken, append a short suffix (e.g. `stpulsedocfuncdevcin01`), keeping the pattern otherwise intact.

Keep this table open in a tab while working through the guide — every step below refers back to these exact names.

---

## Part 1 — Resource Group

1. Portal search bar → **Resource groups** → **+ Create**.
2. Name: `rg-pulsedoc-dev-cin`. Region: **Central India** (matches the `cin` code used everywhere else — keep every resource in this same region unless a step says otherwise).
3. Review + create → Create.

---

## Part 2 — PostgreSQL Flexible Server

1. Portal search bar → **Azure Database for PostgreSQL flexible servers** → **+ Create**.
2. Basics:
   - Resource group: `rg-pulsedoc-dev-cin`
   - Server name: `psql-pulsedoc-dev-cin`
   - Region: Central India
   - PostgreSQL version: **15**
   - Workload type: **Development**
   - Compute + storage → Configure server → **Burstable, B1ms**
   - Authentication: **PostgreSQL authentication only**
   - Admin username: `pulsedocadmin`
   - Password: choose a strong one, save it in your notepad
3. Networking:
   - Connectivity method: **Public access**
   - Check **"Allow public access from any Azure service within Azure to this server"**
   - Click **"+ Add current client IP address"**
4. Review + create → Create.
5. Once ready, copy the **Server name** from its Overview page — this is your `DB_HOST` going forward: `psql-pulsedoc-dev-cin.postgres.database.azure.com`

**Create the database and schema:**
1. pgAdmin → Register → Server. Name: `pulsedoc`. Connection tab: Host = the server name above, Port `5432`, Maintenance database `postgres`, Username `pulsedocadmin`, Password as set.
2. Once connected, right-click **Databases** → Create → Database → name it `pulsedoc` → Save.
3. Right-click the new `pulsedoc` database → Query Tool → paste in `db/schema.sql` (unchanged from before) → run it.

---

## Part 3 — Key Vault

1. Portal search bar → **Key Vault** → **+ Create**.
2. Resource group: `rg-pulsedoc-dev-cin`. Name: `kv-pulsedoc-dev-cin`. Region: Central India. Pricing tier: Standard.
3. Access configuration tab → **Azure role-based access control (RBAC)**.
4. Review + create → Create.
5. Grant yourself data-plane access: Key Vault → Access control (IAM) → + Add → Add role assignment → **Key Vault Secrets Officer** → Members: yourself (User) → Review + assign. Wait a couple of minutes.
6. Key Vault → Secrets → + Generate/Import, one at a time:
   - `secret-pulsedoc-db-host` = `psql-pulsedoc-dev-cin.postgres.database.azure.com`
   - `secret-pulsedoc-db-name` = `pulsedoc`
   - `secret-pulsedoc-db-user` = `pulsedocadmin`
   - `secret-pulsedoc-db-password` = your Flexible Server password
   - `secret-pulsedoc-db-port` = `5432`
   - `secret-pulsedoc-gemini-key` = your Gemini API key (same one as before)
   - `secret-pulsedoc-logicapp-url` = fill this in later, once the Logic App exists (Part 6) — you can leave a placeholder value like `PENDING` for now and edit it afterward

---

## Part 4 — Function App

**Create it:**
1. Portal search bar → **Function App** → **+ Create**.
2. Basics:
   - Resource group: `rg-pulsedoc-dev-cin`
   - Function App name: `func-pulsedoc-processdoc-dev-cin`
   - Publish: **Code**
   - Runtime stack: **Node**, Version **22 LTS**
   - Region: Central India
   - Hosting plan: **Consumption (Windows)** — this is the plan that worked reliably on this subscription; Flex Consumption and Linux App Service both hit Free-Trial-related blocks earlier
3. Storage: create new, name it `stpulsedocfuncdevcin`
4. Monitoring: enable Application Insights, name it `appi-pulsedoc-dev-cin`
5. Review + create → Create.

**Grant it Key Vault access:**
1. Function App → Identity → System assigned → Status **On** → Save.
2. Key Vault (`kv-pulsedoc-dev-cin`) → Access control (IAM) → + Add → Add role assignment → **Key Vault Secrets User** → Members → Managed identity → filter by Function App → select `func-pulsedoc-processdoc-dev-cin` → Review + assign.

**Set its environment variables (Key Vault references):**
1. Function App → Environment variables → add each of these, value = the reference syntax shown:
   - `GEMINI_API_KEY` = `@Microsoft.KeyVault(SecretUri=https://kv-pulsedoc-dev-cin.vault.azure.net/secrets/secret-pulsedoc-gemini-key/)`
   - `DB_HOST` = `@Microsoft.KeyVault(SecretUri=https://kv-pulsedoc-dev-cin.vault.azure.net/secrets/secret-pulsedoc-db-host/)`
   - `DB_NAME` = same pattern → `secret-pulsedoc-db-name`
   - `DB_USER` = same pattern → `secret-pulsedoc-db-user`
   - `DB_PASSWORD` = same pattern → `secret-pulsedoc-db-password`
   - `DB_PORT` = same pattern → `secret-pulsedoc-db-port`
2. Save. Wait a couple of minutes for the role assignment to propagate, then check Kudu's Environment page (Advanced Tools → Go →) to confirm each shows `[Hidden - Resolved: ...]` rather than `AccessToKeyVaultDenied`.

**Deploy the code via Kudu (this OS supports the drag-and-drop page reliably):**
1. Go inside your local `function_app` folder (the code is unchanged from before — same `processDocument.js` using Gemini, same business rules), select `index.js`, `host.json`, `package.json`, `src` — Ctrl+A while standing inside the folder — right-click → compress.
2. Function App → Advanced Tools → Go → → Tools → Zip Push Deploy → drag the zip on.
3. Wait for "Deployment successful". Function App → Functions → confirm `process-document` appears.
4. Click it → Get Function URL → copy the `default (Function key)` one, ending `?code=...` → save to your notepad.

---

## Part 5 — Web App

**Create it:**
1. Portal search bar → **Web App** → **+ Create**.
2. Basics:
   - Resource group: `rg-pulsedoc-dev-cin`
   - Name: `app-pulsedoc-web-dev-cin-001`
   - Publish: **Code**
   - Runtime stack: **Node 22 LTS**
   - Operating System: **Linux**
   - Region: Central India
   - App Service Plan: Create new, name it `asp-pulsedoc-web-dev-cin`, pricing tier **Free F1**
3. Review + create → Create.

**Enable Basic Auth (needed for the Postman deploy method later):**
1. Web App → Configuration → General settings → check **"SCM Basic Auth Publishing Credentials"** → Save.

**Grant it Key Vault access (same pattern as the Function App):**
1. Web App → Identity → System assigned → On → Save.
2. Key Vault → Access control (IAM) → + Add role assignment → **Key Vault Secrets User** → Managed identity → filter by Web App → select `app-pulsedoc-web-dev-cin-001` → Review + assign.

**Set its environment variables:**
1. Web App → Environment variables:
   - `LOGIC_APP_URL` = `PENDING` for now (real value comes after Part 6)
   - `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_PORT` = same `@Microsoft.KeyVault(...)` reference pattern as the Function App, pointing at the matching secrets
   - `SCM_DO_BUILD_DURING_DEPLOYMENT` = `true`
2. Startup Command (Configuration → Stack settings, or General settings depending on your portal version): `npm start`
3. Save.

**One known caveat worth planning for:** in earlier testing on this exact subscription, the Web App's Key Vault references sometimes failed with `AccessToKeyVaultDenied` even with a correctly verified role assignment (matching Object IDs confirmed) — a platform-side propagation issue, not a configuration mistake. If you hit this and a restart doesn't clear it after a few minutes, the documented fallback is reverting just the Web App's variables to plain-text values while keeping the Function App on Key Vault. Worth trying Key Vault first since it may simply work fine on a fresh setup — just don't be surprised if it doesn't, and don't burn excessive time on it if it repeats.

**Build the React client locally:**
```
cd web_app/client
npm install
npm run build
```

**Deploy via Postman (Linux Web Apps don't support Kudu's drag-and-drop page):**
1. Cut `client/node_modules` out temporarily (paste to Desktop). Go inside `web_app`, Ctrl+A to select `index.js`, `package.json`, `client` (now without node_modules) → compress.
2. Web App → Overview → Download publish profile → open in Notepad → find a `userName="..."` / `userPWD="..."` pair.
3. Postman → New Request → POST → `https://<scm-hostname>/api/zipdeploy?isAsync=true` (find the SCM hostname via Web App → Advanced Tools → Go →).
4. Authorization tab → Basic Auth → paste userName/userPWD.
5. Body tab → binary → select your zip.
6. Send → expect **202 Accepted**. Wait a minute, then visit the Web App's URL to confirm the Upload page renders.
7. Move `node_modules` back into `client` afterward.

---

## Part 6 — Logic App

1. Portal search bar → **Logic App** → **+ Create**.
2. Plan type: **Consumption**. Resource group: `rg-pulsedoc-dev-cin`. Name: `logic-pulsedoc-processdocument-dev`. Region: Central India.
3. Review + create → Create.
4. Open it → Logic app code view → paste in `logic_app/workflow.json` (unchanged from before).
5. Replace the placeholder with your actual Function URL (with `?code=...`) from Part 4.
6. Save.
7. Logic app designer → click the trigger box → copy the **HTTP POST URL**.

**Wire it up:**
1. Key Vault → Secrets → edit `secret-pulsedoc-logicapp-url` → replace `PENDING` with this real URL.
2. Web App → Environment variables → `LOGIC_APP_URL` → set to `@Microsoft.KeyVault(SecretUri=https://kv-pulsedoc-dev-cin.vault.azure.net/secrets/secret-pulsedoc-logicapp-url/)` (or the plain URL directly, if you ended up on the plain-text fallback for this app). Save.

---

## Part 7 — Test the full chain

Upload your test PDFs (BP, HbA1c, goal-only, under-18, multiple-dated, diabetes-threshold) through the live Web App URL, confirm each lands in Processed Documents with the expected Status/Measure, and try Retry on one.

---

## Part 8 — CI/CD with GitHub Actions

1. Create a GitHub repo named `pulsedoc`. Push/upload the project (excluding all `node_modules` folders). Create a `dev` branch.
2. **Function App** → Deployment → Deployment Center → Source: GitHub → repo `pulsedoc` → branch `dev` → Save (auto-commits a workflow file).
3. **Web App** → Deployment → Deployment Center → same repo/branch → Authentication type: **Basic authentication** (User-assigned identity/OIDC had a secret-creation issue in earlier testing on this subscription — Basic auth reliably generates its required secret) → Save.
4. Edit both auto-generated workflow files on GitHub (`dev` branch):
   - Repoint any `path: .` to `./function_app` or `./web_app` respectively, so each only packages its own folder, not the whole repo.
   - On the Web App's workflow specifically, add a build step before packaging: `cd web_app/client && npm install && npm run build`, plus a step installing server deps (`cd web_app && npm install --production`) and one removing `client/node_modules` and `client/src` before the artifact upload — same pattern used earlier in this project.
5. Commit directly to `dev`. Check the repo's **Actions** tab for two green runs.
6. Going forward: feature branch → commit → push → PR into `dev` → merge → both pipelines redeploy automatically (a PR merge is a push, same trigger either way).

---

## Later phases
- **Monitoring** — alert rules on `appi-pulsedoc-dev-cin` (CPU/memory/failures) for both apps, plus Flexible Server's own CPU/storage/connection metrics
- **Cleanup** — `rg-pulsedoc-dev-cin` deletion removes everything at once when you're done
