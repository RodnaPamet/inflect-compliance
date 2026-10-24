A throwaway signing key and self-signed certificate for an identity provider
that exists only in tests. Generated with:

    openssl req -x509 -newkey rsa:2048 -nodes -days 36500 \
      -subj "/CN=inflect-test-idp" -keyout key.pem -out cert.pem

Nothing in production trusts this certificate. Tests sign SAML responses with
`key.pem` and configure `cert.pem` as the provider's certificate.
