# State

Tower Crane keeps a project's plan and progress in one SQLite database, `state.db` in the state directory ([Storage](state/storage.md#database)). The CLI is the state writer.

- [Tasks and lifecycle](state/tasks.md)
- [Gates](state/gates.md)
- [Review](state/review.md)
- [CI](state/ci.md)
- [Containment and governor](state/containment.md)
- [Decisions and authority](state/decisions.md)
- [Storage](state/storage.md)
- [Stacks](state/stacks.md)

## Compatibility anchors

Existing links use these anchors. Follow the link to the contract in its area.

<a id="where"></a>[where](state/storage.md#where)

<a id="agent-identity"></a>[agent-identity](state/decisions.md#agent-identity)

<a id="orchestrator-lease"></a>[orchestrator-lease](state/tasks.md#orchestrator-lease)

<a id="authority"></a>[authority](state/decisions.md#authority)

<a id="files"></a>[files](state/storage.md#files)

<a id="durability-and-write-order"></a>[durability-and-write-order](state/storage.md#durability-and-write-order)

<a id="schema-compatibility"></a>[schema-compatibility](state/storage.md#schema-compatibility)

<a id="lock"></a>[lock](state/storage.md#lock)

<a id="dispatch-lock"></a>[dispatch-lock](state/storage.md#dispatch-lock)

<a id="projectjson"></a>[projectjson](state/storage.md#projectjson)

<a id="local-ci-output"></a>[local-ci-output](state/ci.md#local-ci-output)

<a id="ladder"></a>[ladder](state/tasks.md#ladder)

<a id="resource-containment"></a>[resource-containment](state/containment.md#resource-containment)

<a id="host-resource-governor"></a>[host-resource-governor](state/containment.md#host-resource-governor)

<a id="units"></a>[units](state/containment.md#units)

<a id="readings"></a>[readings](state/containment.md#readings)

<a id="the-budget"></a>[the-budget](state/containment.md#the-budget)

<a id="growth-windows"></a>[growth-windows](state/containment.md#growth-windows)

<a id="test-threads"></a>[test-threads](state/containment.md#test-threads)

<a id="stopping"></a>[stopping](state/containment.md#stopping)

<a id="deferral-and-resumption"></a>[deferral-and-resumption](state/containment.md#deferral-and-resumption)

<a id="settings"></a>[settings](state/containment.md#settings)

<a id="registry"></a>[registry](state/containment.md#registry)

<a id="degraded"></a>[degraded](state/containment.md#degraded)

<a id="tasksjson"></a>[tasksjson](state/tasks.md#tasksjson)

<a id="already-merged-hotfixes"></a>[already-merged-hotfixes](state/tasks.md#already-merged-hotfixes)

<a id="research-sources"></a>[research-sources](state/tasks.md#research-sources)

<a id="ready-and-blocked"></a>[ready-and-blocked](state/tasks.md#ready-and-blocked)

<a id="release-for-a-decision"></a>[release-for-a-decision](state/tasks.md#release-for-a-decision)

<a id="spawned-process-exits"></a>[spawned-process-exits](state/tasks.md#spawned-process-exits)

<a id="acceptance-gates"></a>[acceptance-gates](state/gates.md#acceptance-gates)

<a id="worker-written-code-and-config-outside-the-sandbox"></a>[worker-written-code-and-config-outside-the-sandbox](state/containment.md#worker-written-code-and-config-outside-the-sandbox)

<a id="what-the-git-and-gh-shims-guard"></a>[what-the-git-and-gh-shims-guard](state/containment.md#what-the-git-and-gh-shims-guard)

<a id="decisionsjson"></a>[decisionsjson](state/decisions.md#decisionsjson)

<a id="eventsjsonl"></a>[eventsjsonl](state/storage.md#eventsjsonl)

<a id="orchestrator-inbox"></a>[orchestrator-inbox](state/tasks.md#orchestrator-inbox)

<a id="repeated-review-failures"></a>[repeated-review-failures](state/review.md#repeated-review-failures)

<a id="owner-rows"></a>[owner-rows](state/decisions.md#owner-rows)

<a id="publish-policy"></a>[publish-policy](state/decisions.md#publish-policy)

<a id="fallback-route-grants"></a>[fallback-route-grants](state/decisions.md#fallback-route-grants)

<a id="native-crashes"></a>[native-crashes](state/tasks.md#native-crashes)

<a id="final-review"></a>[final-review](state/gates.md#final-review)

<a id="pr-owners"></a>[pr-owners](state/tasks.md#pr-owners)

<a id="live-window-replay-2026-10-21-t451"></a>[live-window-replay-2026-10-21-t451](state/containment.md#live-window-replay-2026-10-21-t451)

<a id="command-environment"></a>[command-environment](state/tasks.md#command-environment)

<a id="host-tmp"></a>[host-tmp](state/tasks.md#host-tmp)

<a id="credentials"></a>[credentials](state/tasks.md#credentials)

<a id="broker-verbs"></a>[broker-verbs](state/containment.md#broker-verbs)

<a id="local-ci-reruns"></a>[local-ci-reruns](state/ci.md#local-ci-reruns)

<a id="gate-reruns"></a>[gate-reruns](state/gates.md#gate-reruns)

<a id="flake-ledger"></a>[flake-ledger](state/gates.md#flake-ledger)

<a id="scratch-archive"></a>[scratch-archive](state/storage.md#scratch-archive)
