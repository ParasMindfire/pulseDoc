// =============================================================================
// PulseDoc infrastructure — Azure Bicep
// =============================================================================
// WHAT THIS FILE DOES
//   Declares the shape of the Azure resources PulseDoc runs on (Key Vault
//   secrets, Application Insights, the Function App + its Consumption plan,
//   the Web App + its Free plan, RBAC role assignments, and the Logic App)
//   so they can be created/updated by running one command instead of
//   clicking through the Azure Portal (see README_PULSEDOC.md Parts 1-8).
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
//   - Create the resource group itself. This file deploys INTO an existing
//     resource group (targetScope below is 'resourceGroup'). Create
//     rg-pulsedoc-dev-cin manually once, same as README Part 1.
//   - Create the Key Vault. It's referenced with `existing` (read-only
//     reference), not created, because Key Vault + its access policies are
//     sensitive enough to want a deliberate one-time setup (README Part 3).
//   - Create the PostgreSQL Flexible Server. Same reasoning, one level up:
//     it holds the actual data. Provisioning a DB server via IaC is
//     absolutely possible, it's just intentionally excluded here so a bad
//     `what-if` approval can never delete a data-bearing resource. Keep
//     following README Part 2 for that piece.
//
// !! BEFORE YOU RUN THIS AGAINST YOUR REAL RESOURCE GROUP, READ infra/REVIEW.md !!
// It has a line-by-line explanation and a checklist of names/values you must
// verify match your actual Azure resources first. Getting a name wrong here
// doesn't fail loudly — Bicep will happily try to CREATE A NEW resource next
// to your real one instead of updating it.
//
// !! APPSETTINGS WARNING !!
// The `appSettings` arrays below are sent as a full replacement, not a merge,
// for the Function App and Web App. If your live app currently has settings
// that aren't listed below (Azure sometimes adds its own, e.g.
// WEBSITE_CONTENTAZUREFILECONNECTIONSTRING / WEBSITE_CONTENTSHARE on
// Consumption Function Apps), deploying this file will silently remove them.
// REVIEW.md explains exactly how to check this before your first deploy.
// =============================================================================

targetScope = 'resourceGroup'

// -----------------------------------------------------------------------
// PARAMETERS — the inputs. Everything with a default can be left alone for
// the dev environment; the two @secure() ones have NO default on purpose,
// so Bicep refuses to deploy unless you (or the pipeline) actually supply
// them — you can never accidentally deploy with an empty password.
// -----------------------------------------------------------------------

@description('Environment short code — matches the {env} slot in your naming table.')
param env string = 'dev'

@description('Region code used in resource names — matches the {region} slot in your naming table.')
param regionCode string = 'cin'

@description('Actual Azure region resources get placed in. Must match where rg-pulsedoc-dev-cin already lives.')
param location string = 'centralindia'

@secure()
@description('Admin password for the PostgreSQL Flexible Server. Must be the REAL existing password, not a new one — this file does not create the server, it only writes this value into a Key Vault secret so the apps can read it. Pass via --parameters, never commit it.')
param dbAdminPassword string

@secure()
@description('Your Gemini API key. Same idea as above — passed in at deploy time, written into Key Vault, never committed.')
param geminiApiKey string

@secure()
@description('The real Function App URL, including the ?code= key, that the Logic App calls. Rotated after the secret-scanning incident on 2026-09-09 — never commit this value into logic_app/workflow.json again, it belongs here and in the FUNCTION_APP_URL GitHub secret only.')
param functionAppUrl string

// -----------------------------------------------------------------------
// VARIABLES — computed names, built from the params above using the exact
// pattern from your naming table in README_PULSEDOC.md, so nothing here is
// a "magic string" you'd have to remember to update in two places.
// -----------------------------------------------------------------------

var appName = 'pulsedoc'
var kvName = 'kv-${appName}-${env}-${regionCode}'                      // kv-pulsedoc-dev-cin
var funcName = 'func-${appName}-processdoc-${env}-${regionCode}'       // func-pulsedoc-processdoc-dev-cin
var webName = 'app-${appName}-web-${env}-${regionCode}-001'            // app-pulsedoc-web-dev-cin-001
var funcStorageName = 'st${appName}func${env}${regionCode}'            // stpulsedocfuncdevcin (no hyphens allowed)
var webPlanName = 'asp-${appName}-web-${env}-${regionCode}'            // asp-pulsedoc-web-dev-cin
var logicAppName = 'logic-${appName}-processdocument-${env}'           // logic-pulsedoc-processdocument-dev
var dbHost = 'psql-${appName}-${env}-${regionCode}.postgres.database.azure.com'

// The Function App's Consumption plan was auto-named by the portal when it
// was created (Y1/Consumption plans get a generated name like
// "ASP-<rg>-<hash>", never typed by hand). App Service Plan names are
// IMMUTABLE — there's no "rename," only "create a new one and move the app
// onto it." Not worth that churn for an invisible Consumption plan, so this
// file ADOPTS the real one instead of inventing a new name. Confirmed via a
// real `what-if` run — if yours differs, update this to match.
var funcPlanName = 'ASP-rgpulsedocdevcin-b035'

// Built-in Azure role definition IDs (these GUIDs are the same in every
// subscription — they identify the ROLE, e.g. "Key Vault Secrets User",
// not a specific assignment of it).
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

// -----------------------------------------------------------------------
// EXISTING RESOURCE — a read-only reference to your Key Vault. The
// `existing` keyword means "don't create this, just let me read its
// properties / attach child resources to it." If kvName doesn't match a
// real Key Vault in this resource group, everything below that depends on
// `kv` fails at deploy time with a clear "not found" error (safe failure).
// -----------------------------------------------------------------------
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: kvName
}

// -----------------------------------------------------------------------
// KEY VAULT SECRETS — each of these is a child resource of `kv` (the
// `parent: kv` line is what makes it a child rather than a standalone
// resource). Re-running this deploy just updates the value if the secret
// name already exists — Key Vault secrets aren't versioned-away by this,
// Azure keeps prior versions automatically.
// -----------------------------------------------------------------------
resource secretDbHost 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'secret-pulsedoc-db-host'
  properties: { value: dbHost }
}
resource secretDbName 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'secret-pulsedoc-db-name'
  properties: { value: 'pulsedoc' }
}
resource secretDbUser 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'secret-pulsedoc-db-user'
  properties: { value: 'pulsedocadmin' }
}
resource secretDbPassword 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'secret-pulsedoc-db-password'
  properties: { value: dbAdminPassword }
}
resource secretDbPort 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'secret-pulsedoc-db-port'
  properties: { value: '5432' }
}
resource secretGemini 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'secret-pulsedoc-gemini-key'
  properties: { value: geminiApiKey }
}
// secret-pulsedoc-logicapp-url's VALUE is intentionally NOT managed here —
// same chicken/egg as README Part 6: the Logic App's trigger URL only
// exists AFTER the Logic App below is deployed. Set/update that one
// secret's value manually (Key Vault → Secrets → edit) after your first
// deploy (or after regenerating the Function key, since that URL embeds
// it). The webApp resource below DOES reference this secret by URI — this
// file just never writes its value.

// -----------------------------------------------------------------------
// APPLICATION INSIGHTS — read-only references to what ALREADY exists.
// Enabling monitoring during app creation (README Parts 4 & 5) made the
// portal auto-create ONE Application Insights component PER APP, named
// after the app itself — not the appi-pulsedoc-dev-cin pattern the naming
// table implied. Confirmed via `what-if`: it already showed
// microsoft.insights/components/app-pulsedoc-web-dev-cin-001 and
// .../func-pulsedoc-processdoc-dev-cin as pre-existing. This file
// deliberately does NOT create a third, shared, disconnected component —
// that would orphan both apps from their real telemetry history. Adopt the
// two that already exist instead.
// -----------------------------------------------------------------------
resource funcAppInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: funcName
}
resource webAppInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: webName
}

// -----------------------------------------------------------------------
// FUNCTION APP — Consumption plan (Y1/Dynamic), Windows, Node 22.
// -----------------------------------------------------------------------

// The storage account every Function App needs internally (triggers,
// bindings, and the file share backing the app's code). This is a SEPARATE
// concern from your app's own Postgres DB.
resource funcStorage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: funcStorageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
}

// The hosting plan — Y1/Dynamic = "Consumption" (pay per execution, what
// README Part 4 selected in the portal). Adopted as `existing`; see the
// funcPlanName comment above for why this isn't created fresh.
resource funcPlan 'Microsoft.Web/serverfarms@2023-01-01' existing = {
  name: funcPlanName
}

resource functionApp 'Microsoft.Web/sites@2023-01-01' = {
  name: funcName
  location: location
  kind: 'functionapp'                        // distinguishes a Function App from a plain Web App
  identity: { type: 'SystemAssigned' }        // gives this app its own Azure AD identity, used below for Key Vault access — same as README Part 4's "Identity → System assigned → On"
  properties: {
    serverFarmId: funcPlan.id                 // .id is an implicit dependency: Bicep deploys funcPlan first automatically
    siteConfig: {
      // NOTE: this whole appSettings array REPLACES whatever's live today.
      // See the big warning at the top of this file before your first run.
      appSettings: [
        { name: 'AzureWebJobsStorage', value: 'DefaultEndpointsProtocol=https;AccountName=${funcStorage.name};AccountKey=${funcStorage.listKeys().keys[0].value};EndpointSuffix=core.windows.net' }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~22' }
        { name: 'APPINSIGHTS_INSTRUMENTATIONKEY', value: funcAppInsights.properties.InstrumentationKey }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: funcAppInsights.properties.ConnectionString }
        // The next 4 were NOT part of the original portal-created default —
        // confirmed live via `az functionapp config appsettings list` before
        // the first real deploy (see infra/REVIEW.md findings). Without
        // these, the appSettings full-replace would have silently dropped
        // them, and WEBSITE_RUN_FROM_PACKAGE specifically is very likely
        // what makes the currently zip-deployed code actually run.
        { name: 'AzureWebJobsSecretStorageType', value: 'files' }
        { name: 'SCM_COMMAND_IDLE_TIMEOUT', value: '1800' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
        { name: 'WEBSITE_ENABLE_SYNC_UPDATE_SITE', value: 'true' }
        // The next 6 are Key Vault references — same @Microsoft.KeyVault(...)
        // syntax you typed by hand in the portal in README Part 4, just
        // generated here from each secret's own .properties.secretUri so a
        // typo in a vault URI is structurally impossible.
        { name: 'GEMINI_API_KEY', value: '@Microsoft.KeyVault(SecretUri=${secretGemini.properties.secretUri})' }
        { name: 'DB_HOST', value: '@Microsoft.KeyVault(SecretUri=${secretDbHost.properties.secretUri})' }
        { name: 'DB_NAME', value: '@Microsoft.KeyVault(SecretUri=${secretDbName.properties.secretUri})' }
        { name: 'DB_USER', value: '@Microsoft.KeyVault(SecretUri=${secretDbUser.properties.secretUri})' }
        { name: 'DB_PASSWORD', value: '@Microsoft.KeyVault(SecretUri=${secretDbPassword.properties.secretUri})' }
        { name: 'DB_PORT', value: '@Microsoft.KeyVault(SecretUri=${secretDbPort.properties.secretUri})' }
      ]
    }
  }
}

// Grants the Function App's own identity permission to READ Key Vault
// secrets (data-plane access — separate from, and not implied by, any
// Contributor/Owner role at the resource-group level). Same effect as
// README Part 4's "Key Vault → IAM → Key Vault Secrets User → Function App".
resource funcKvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  // The name of a role assignment must be a GUID. guid(...) deterministically
  // derives one from its inputs, so re-running this deploy always produces
  // the SAME guid for the SAME (vault, app, role) combo — which is what
  // makes this update-in-place instead of erroring on "already exists" or
  // silently creating a duplicate assignment.
  name: guid(kv.id, functionApp.id, keyVaultSecretsUserRoleId)
  scope: kv
  properties: {
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

// -----------------------------------------------------------------------
// WEB APP — Linux, Node 22, Free (F1) plan.
// -----------------------------------------------------------------------

resource webPlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: webPlanName
  location: location
  kind: 'linux'
  // B1/Basic, not F1/Free — the naming table originally called for Free,
  // but a real `what-if` run showed the live plan is already on B1
  // (confirmed intentional, not accidental). Deploying F1 here would have
  // silently downgraded it. If you ever want to drop back to Free, this is
  // the only line to change.
  sku: { name: 'B1', tier: 'Basic' }
  properties: { reserved: true }              // required for Linux plans specifically
}

resource webApp 'Microsoft.Web/sites@2023-01-01' = {
  name: webName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: webPlan.id
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'           // the Linux-stack equivalent of README Part 5's "Runtime stack: Node 22 LTS"
      appCommandLine: 'npm start'             // README Part 5's "Startup Command"
      appSettings: [
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
        { name: 'APPINSIGHTS_INSTRUMENTATIONKEY', value: webAppInsights.properties.InstrumentationKey }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: webAppInsights.properties.ConnectionString }
        { name: 'ApplicationInsightsAgent_EXTENSION_VERSION', value: '~3' }
        { name: 'XDT_MicrosoftApplicationInsights_Mode', value: 'default' }
        // Confirmed live as a proper Key Vault reference (not the plain-text
        // fallback README_PULSEDOC.md warns about) — the secret itself
        // already holds the real Logic App trigger URL from README Part 6,
        // this file just needed to declare the App Setting pointing at it.
        // Built from kv.properties.vaultUri directly since this file doesn't
        // manage secret-pulsedoc-logicapp-url itself (see the comment above
        // secretGemini for why).
        { name: 'LOGIC_APP_URL', value: '@Microsoft.KeyVault(SecretUri=${kv.properties.vaultUri}secrets/secret-pulsedoc-logicapp-url/)' }
        { name: 'DB_HOST', value: '@Microsoft.KeyVault(SecretUri=${secretDbHost.properties.secretUri})' }
        { name: 'DB_NAME', value: '@Microsoft.KeyVault(SecretUri=${secretDbName.properties.secretUri})' }
        { name: 'DB_USER', value: '@Microsoft.KeyVault(SecretUri=${secretDbUser.properties.secretUri})' }
        { name: 'DB_PASSWORD', value: '@Microsoft.KeyVault(SecretUri=${secretDbPassword.properties.secretUri})' }
        { name: 'DB_PORT', value: '@Microsoft.KeyVault(SecretUri=${secretDbPort.properties.secretUri})' }
      ]
    }
  }
}

resource webKvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, webApp.id, keyVaultSecretsUserRoleId)
  scope: kv
  properties: {
    principalId: webApp.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

// -----------------------------------------------------------------------
// LOGIC APP — Consumption. The workflow body is loaded straight from the
// real file in this repo, so the workflow logic still has exactly one
// source of truth (logic_app/workflow.json), not a second copy pasted
// into this Bicep file that could drift out of sync with it.
// -----------------------------------------------------------------------
resource logicApp 'Microsoft.Logic/workflows@2019-05-01' = {
  name: logicAppName
  location: location
  properties: {
    // Pinned explicitly — omitting this left `state` undeclared, and a real
    // what-if run showed it as a property that would be removed from the
    // resource on deploy. Rather than trust whatever Azure's default
    // happens to be, keep the workflow explicitly Enabled.
    state: 'Enabled'
    definition: loadJsonContent('../logic_app/workflow.json').definition
    // The workflow file itself only ever contains a PLACEHOLDER for
    // functionUrl (it's committed to git — never put the real value there,
    // that's exactly what triggered GitHub's push protection earlier). The
    // real value is injected here, at deploy time, from a @secure() param —
    // same treatment as dbAdminPassword/geminiApiKey below.
    parameters: {
      functionUrl: { value: functionAppUrl }
    }
  }
}

// -----------------------------------------------------------------------
// OUTPUTS — values printed after a successful deploy (and readable by a
// later pipeline step). None of these are secret, so they're safe to
// output in plain text (contrast with dbAdminPassword/geminiApiKey above,
// which are @secure() and never appear in outputs or logs).
// -----------------------------------------------------------------------
output functionAppName string = functionApp.name
output functionAppHostName string = functionApp.properties.defaultHostName
output webAppName string = webApp.name
output webAppHostName string = webApp.properties.defaultHostName
output logicAppName string = logicApp.name
output keyVaultUri string = kv.properties.vaultUri
