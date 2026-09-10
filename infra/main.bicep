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

@description('Email address that receives monitoring alerts (downtime, 5xx errors). Not secret, just a plain param — override via --parameters if you ever want a different inbox.')
param alertEmail string = 'parascet2025@gmail.com'

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

// NOTE on Key Vault access: both apps already have "Key Vault Secrets User"
// granted to their managed identities — done manually per README Parts 4-5
// ("Key Vault → IAM → Key Vault Secrets User → <app>"), confirmed still live
// by a real deploy attempt here (Azure rejected this file's own attempt to
// (re-)create those same two role assignments with `RoleAssignmentExists` —
// Azure enforces uniqueness on the (principal, role, scope) triple itself,
// not on the assignment's own name/GUID, so redeclaring an
// already-granted permission is a conflict, not a safe no-op). Rather than
// fight that, this file simply doesn't manage these two role assignments —
// they're adopted implicitly by already existing and working.

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
      // App Service pings this path every ~1 min and marks the instance
      // unhealthy after repeated failures — see the /health route added to
      // web_app/index.js, which deliberately skips the DB so a slow Postgres
      // doesn't get misread as "the whole app is down." Not supported on
      // Consumption-plan Function Apps, so this only applies here.
      healthCheckPath: '/health'
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

// (webApp's equivalent role assignment — see the note above funcKvRole's
// old location: already granted manually, not managed here, same reason.)

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
// MONITORING — "essentials" tier: get emailed when the site is down or
// either app starts throwing server errors. Deliberately NOT a Log
// Analytics workspace / Workbook — that's a recurring cost this dev
// environment doesn't need; everything below reads off metrics the
// platform + existing App Insights components already emit for free.
// -----------------------------------------------------------------------

// One action group, reused by every alert below. To add a second
// recipient (e.g. a teammate, or SMS), add another entry to emailReceivers
// or an smsReceivers array here — no need to touch the alerts themselves.
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-${appName}-${env}-alerts'
  // Action groups are usually created as 'global', but the real one (made
  // manually in the Portal first, per this project's usual workflow) ended
  // up with location = 'centralindia' instead — confirmed via a real deploy
  // failure (InvalidResourceLocation) on 2026-09-10. Location is immutable
  // on an existing resource, so this matches what's actually live instead
  // of fighting it.
  location: location

  properties: {
    groupShortName: 'pdalerts'                // max 12 chars, shows in the alert email subject
    enabled: true
    emailReceivers: [
      {
        name: 'primary-email'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

// Availability (ping) test — hits the Web App's real public URL every 5
// minutes from 2 Azure regions and fires if it doesn't get a 200 back
// within 30s. This is the one check that catches "site is completely
// unreachable," which the Http5xx alert below can't — a dead site
// returns nothing, not a 5xx.
// `kind: 'standard'` (top-level resource property, not inside `properties`)
// — Azure retired portal creation of the old "classic" ping test (the
// `Kind: 'ping'` + XML `Configuration.WebTest` shape); the portal's
// "+ Create standard test" button now creates this shape instead. Matching
// it here means clicking through that button first, then running this file,
// updates the same resource instead of leaving two different tests behind.
resource webAvailabilityTest 'Microsoft.Insights/webtests@2022-06-15' = {
  name: 'webtest-${webName}-availability'
  location: location
  tags: {
    // this hidden-link tag is what makes the Portal show the test's
    // results inside the Web App's own Application Insights component
    // instead of as an orphaned resource
    'hidden-link:${webAppInsights.id}': 'Resource'
  }
  kind: 'standard'
  properties: {
    SyntheticMonitorId: 'webtest-${webName}-availability'
    Name: 'PulseDoc Web App availability'
    Enabled: true
    // 900s (15 min), 1 location — NOT the original 300s/2-location config.
    // Standard tests are billed per execution ("Standard Web Test Execution"
    // in Cost Analysis), confirmed 2026-09-10 by a real bill on an unrelated
    // project where this exact meter was ~98% of that resource group's
    // spend. 15 min instead of 5 min = 1/3 the executions; 1 location
    // instead of 2 = half again — roughly 6x cheaper than the original
    // config, appropriate for a dev app where "found out within 15 min"
    // is plenty. Trade-off: with only 1 location, a single region's
    // transient network blip can't be cross-checked against a second one
    // before alerting (see failedLocationCount below) — acceptable here,
    // reconsider if this ever needs production-grade reliability.
    Frequency: 900
    Timeout: 30
    Kind: 'standard'
    RetryEnabled: true
    Locations: [
      { Id: 'apac-sg-sin-azr' }                // Southeast Asia — closest public test region to Central India
    ]
    Request: {
      RequestUrl: 'https://${webApp.properties.defaultHostName}/health'
      HttpVerb: 'GET'
      ParseDependentRequests: false
      FollowRedirects: true
    }
    ValidationRules: {
      ExpectedHttpStatusCode: 200
      SSLCheck: false
    }
  }
}

// The webtest above only RUNS the check — on its own it notifies nobody.
// Availability alerts use a dedicated criteria type that has to reference
// BOTH the webtest and the Application Insights component together (not
// just a plain metric on one resource, unlike the Http5xx/RunsFailed alerts
// below), which is also why the Portal's "Create standard test" wizard
// doesn't ask for an action group anymore — that step moved to its own
// alert rule, created here.
// failedLocationCount: 1 — matches the single test location above (can't
// require 2-out-of-2 when there's only 1 configured). If you later add a
// second location back, bump this to 2 to restore the "both must fail"
// false-positive guard.
resource webAvailabilityAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${webAvailabilityTest.name}'
  location: 'global'
  properties: {
    description: 'Web App (${webName}) availability test failed in the last 15 minutes.'
    severity: 1
    enabled: true
    scopes: [
      webAvailabilityTest.id
      webAppInsights.id
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
      webTestId: webAvailabilityTest.id
      componentId: webAppInsights.id
      failedLocationCount: 1
    }
    actions: [
      { actionGroupId: actionGroup.id }
    ]
  }
}

// Fires when the Web App returns 1+ HTTP 5xx response in a 5-minute
// window. Severity 2 = Warning (not the most urgent tier, but still
// emails immediately) — bump to 1 later if 5xx bursts turn out to matter
// more than that.
resource webApp5xxAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${webName}-http5xx'
  location: 'global'
  properties: {
    description: 'Web App (${webName}) returned one or more HTTP 5xx responses in the last 5 minutes.'
    severity: 2
    enabled: true
    scopes: [ webApp.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    targetResourceType: 'Microsoft.Web/sites'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'Http5xxErrors'
          metricName: 'Http5xx'
          metricNamespace: 'Microsoft.Web/sites'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      { actionGroupId: actionGroup.id }
    ]
  }
}

// Same idea, scoped to the Function App instead.
resource functionApp5xxAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${funcName}-http5xx'
  location: 'global'
  properties: {
    description: 'Function App (${funcName}) returned one or more HTTP 5xx responses in the last 5 minutes.'
    severity: 2
    enabled: true
    scopes: [ functionApp.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    targetResourceType: 'Microsoft.Web/sites'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'Http5xxErrors'
          metricName: 'Http5xx'
          metricNamespace: 'Microsoft.Web/sites'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      { actionGroupId: actionGroup.id }
    ]
  }
}

// Fires when the Logic App has 1+ failed run in a 15-minute window. Window
// is wider than the two Http5xx alerts above (5 min) on purpose — this
// workflow only runs when someone uploads a document, not on a schedule, so
// a 5-minute window could span long idle gaps and doesn't need to be that
// tight; 15 minutes still means you hear about a failed upload well within
// the same sitting.
resource logicAppRunsFailedAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${logicAppName}-runsfailed'
  location: 'global'
  properties: {
    description: 'Logic App (${logicAppName}) had one or more failed runs in the last 15 minutes.'
    severity: 2
    enabled: true
    scopes: [ logicApp.id ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    targetResourceType: 'Microsoft.Logic/workflows'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'RunsFailed'
          metricName: 'RunsFailed'
          metricNamespace: 'Microsoft.Logic/workflows'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      { actionGroupId: actionGroup.id }
    ]
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
output actionGroupName string = actionGroup.name
output webAvailabilityTestName string = webAvailabilityTest.name
output webAvailabilityAlertName string = webAvailabilityAlert.name
output logicAppRunsFailedAlertName string = logicAppRunsFailedAlert.name
