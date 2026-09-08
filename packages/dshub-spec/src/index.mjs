export { validate, validateForWrite, validateBundleRefs, assertNoSecrets } from './validate.mjs';

import datasourceConfigSchema from '../datasource-config.schema.json' with { type: 'json' };
import schemaArtifactSchema from '../schema-artifact.schema.json' with { type: 'json' };
import controlProtocolSchema from '../control-protocol.schema.json' with { type: 'json' };

export { datasourceConfigSchema, schemaArtifactSchema, controlProtocolSchema };
