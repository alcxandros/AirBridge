'use strict';
// Local certificate authority for the phone page's HTTPS.
//
// The phone installs and trusts the CA once; AirBridge then issues server
// certificates for the PC's LAN addresses. The CA is name-constrained to
// private IP ranges and *.local, so even if its key leaked it could not be
// used to impersonate real websites to the phone.

const crypto = require('crypto');
const os = require('os');
const forge = require('node-forge');

const { asn1, pki } = forge;

const PERMITTED_IPS = [
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
];

const ipBytes = (ip) => String.fromCharCode(...ip.split('.').map(Number));

/** DER for X.509 NameConstraints: permitted private IPv4 ranges and the .local domain. */
function nameConstraintsDer() {
  const subtree = (base) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [base]);
  const subtrees = [
    ...PERMITTED_IPS.map(([ip, mask]) => subtree(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 7, false, ipBytes(ip) + ipBytes(mask)))),
    subtree(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 2, false, 'local')),
  ];
  const nc = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, subtrees),
  ]);
  return asn1.toDer(nc).getBytes();
}

function newKeyPair() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const key = pki.privateKeyFromPem(pem);
  return { pem, key, pub: pki.setRsaPublicKey(key.n, key.e) };
}

function serial() {
  // Positive, 16 random bytes.
  const b = crypto.randomBytes(16);
  b[0] &= 0x7f;
  return b.toString('hex');
}

/** Creates the CA. Returns { keyPem, certPem }. */
function createCa(label = os.hostname()) {
  const { pem, key, pub } = newKeyPair();
  const cert = pki.createCertificate();
  cert.publicKey = pub;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
  const name = [
    { name: 'commonName', value: `AirBridge local CA (${String(label).slice(0, 40)})` },
    { name: 'organizationName', value: 'AirBridge' },
  ];
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { id: '2.5.29.30', critical: true, value: nameConstraintsDer() },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(key, forge.md.sha256.create());
  return { keyPem: pem, certPem: pki.certificateToPem(cert) };
}

/**
 * Issues a server certificate for the given IPv4 addresses and host name
 * (as <host>.local), signed by the CA. Returns { keyPem, certPem }.
 */
function issueServerCert({ caKeyPem, caCertPem, ips, host = os.hostname() }) {
  const caKey = pki.privateKeyFromPem(caKeyPem);
  const caCert = pki.certificateFromPem(caCertPem);
  const { pem, key, pub } = newKeyPair();
  const cert = pki.createCertificate();
  cert.publicKey = pub;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000);
  // Apple requires TLS server certs to be valid for at most 825 days; stay well under.
  cert.validity.notAfter = new Date(Date.now() + 397 * 24 * 60 * 60 * 1000);
  // No commonName: some clients treat it as a DNS name, which the CA's constraints wouldn't allow.
  cert.setSubject([{ name: 'organizationName', value: 'AirBridge' }]);
  cert.setIssuer(caCert.subject.attributes);
  const altNames = ips.map((ip) => ({ type: 7, ip }));
  const dnsHost = String(host).toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (dnsHost) altNames.push({ type: 2, value: `${dnsHost}.local` });
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames, critical: true },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { keyPem: pem, certPem: pki.certificateToPem(cert) };
}

/** SHA-256 fingerprint shown in the app so the user can compare it on the phone. */
function fingerprint(certPem) {
  return new crypto.X509Certificate(certPem).fingerprint256;
}

module.exports = { createCa, issueServerCert, fingerprint, nameConstraintsDer };
