package com.example.hybriddebug

object DevShellConfig {

    const val DEFAULT_PROD_URL = "http://10.0.2.2:8080"
    const val DEFAULT_SYNC_URL = "http://10.0.2.2:9090"
    const val DEFAULT_SYNC_TOKEN = "demo-sync-token"

    /** Simulates the token native obtains from its login API. */
    const val NATIVE_TOKEN = "native-demo-token"

    /**
     * The path native opens after it has a token. The web app knows how to read
     * ?token=... on this path. Keep this in the DevShell, not in production.
     */
    const val ENTRY_PATH = "/sso"

    /** Must match dev-keys/bundle-signing-key.pub.base64 in the demo repo. */
    const val BUNDLE_PUBLIC_KEY_BASE64 =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE336J5RpFxACvPtlAYI9bX0wXf/qH6rYKHfZ/irNBnZ1enk5bY9/NsJdi4gdttWC6cvySGdimv5pE1dzae8K4vA=="

    const val BUNDLE_KEY_ID = "demo-dev-1"

    const val USER_AGENT_SUFFIX = " HybridDevShell/0.1"
}
