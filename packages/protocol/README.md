# @serovaai/ficta-protocol

Shared wire contracts for the Ficta proxy control plane. The package is dependency-free and contains
endpoint constants, runtime guards, versioned managed-registry file contracts, and TypeScript
declarations used by the proxy and Ficta Gateway. Gateway-local network and presentation errors do
not belong to this package.

The control-plane contract includes the loopback-only pre-send protection preview endpoint and its opaque,
short-lived ticket header. Tickets are bound to the reviewed current message and consumed on first use.
Preview responses contain redacted text, UTF-16 finding coordinates, safe detector metadata, and surrogates;
raw user-selected values remain in the loopback request and proxy scope rather than being carried in
model-request headers.
