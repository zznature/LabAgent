# Artifact representations use SHA-256

Every formal source and canonical artifact representation records its byte size and SHA-256 digest. Runtime verifies these values before publication and staging cleanup. File modification time is not accepted as evidence of completeness or identity; the digest supports corruption detection, safe download caching, deployment synchronization, and later data migration verification.
