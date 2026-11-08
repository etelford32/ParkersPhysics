"""store.py — where the worker writes: Cloudflare R2, or a local directory.

R2 is S3-compatible; the SAME four secrets the Vercel side reads
(api/_lib/r2-client.js): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
R2_BUCKET (+ optional R2_ENDPOINT). With any of them unset the worker writes
to a local directory and SAYS SO — the run is then a dry run, never a silent
success (the r2_not_configured rule of SUPABASE_OFFLOAD_PLAN.md).

COMMIT ORDER (the archive-sweep rule, R2-only here because nothing in
Postgres is trimmed): every tile first, then the run's manifest, then the
`latest` pointer, then retention. A run without a manifest does not exist to
any reader, so a crash mid-upload publishes nothing.
"""

from __future__ import annotations

import gzip
import os
import pathlib


def r2_env():
    keys = ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET')
    env = {k: os.environ.get(k, '') for k in keys}
    if not all(env.values()):
        return None
    env['R2_ENDPOINT'] = os.environ.get('R2_ENDPOINT') or f"https://{env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
    return env


class LocalStore:
    kind = 'local'

    def __init__(self, root):
        self.root = pathlib.Path(root)

    def put(self, key, data, content_type='application/octet-stream'):
        p = self.root / key
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def get(self, key):
        p = self.root / key
        return p.read_bytes() if p.exists() else None

    def list_prefixes(self, prefix):
        p = self.root / prefix
        return sorted(f'{prefix}{c.name}/' for c in p.iterdir() if c.is_dir()) if p.exists() else []

    def delete_prefix(self, prefix):
        import shutil
        shutil.rmtree(self.root / prefix, ignore_errors=True)


class R2Store:
    kind = 'r2'

    def __init__(self, env):
        import boto3
        from botocore.config import Config
        self.bucket = env['R2_BUCKET']
        self.s3 = boto3.client(
            's3', endpoint_url=env['R2_ENDPOINT'], region_name='auto',
            aws_access_key_id=env['R2_ACCESS_KEY_ID'],
            aws_secret_access_key=env['R2_SECRET_ACCESS_KEY'],
            config=Config(retries={'max_attempts': 5, 'mode': 'standard'}, max_pool_connections=64),
        )

    def put(self, key, data, content_type='application/octet-stream'):
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def get(self, key):
        try:
            return self.s3.get_object(Bucket=self.bucket, Key=key)['Body'].read()
        except self.s3.exceptions.NoSuchKey:
            return None

    def list_prefixes(self, prefix):
        out, token = [], None
        while True:
            kw = {'Bucket': self.bucket, 'Prefix': prefix, 'Delimiter': '/'}
            if token:
                kw['ContinuationToken'] = token
            r = self.s3.list_objects_v2(**kw)
            out += [c['Prefix'] for c in r.get('CommonPrefixes', [])]
            if not r.get('IsTruncated'):
                return sorted(out)
            token = r['NextContinuationToken']

    def delete_prefix(self, prefix):
        token = None
        while True:
            kw = {'Bucket': self.bucket, 'Prefix': prefix}
            if token:
                kw['ContinuationToken'] = token
            r = self.s3.list_objects_v2(**kw)
            objs = [{'Key': o['Key']} for o in r.get('Contents', [])]
            for i in range(0, len(objs), 1000):
                self.s3.delete_objects(Bucket=self.bucket, Delete={'Objects': objs[i:i + 1000]})
            if not r.get('IsTruncated'):
                return
            token = r['NextContinuationToken']


def open_store(local_dir):
    env = r2_env()
    return (R2Store(env), None) if env else (LocalStore(local_dir), 'r2_not_configured')


def gz(text):
    return gzip.compress(text.encode('utf-8'), mtime=0)
