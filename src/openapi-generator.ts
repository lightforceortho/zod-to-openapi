import {
  ReferenceObject,
  SchemaObject,
  ParameterObject,
  RequestBodyObject,
  PathItemObject,
  PathObject,
  OpenAPIObject,
  InfoObject,
  ServerObject,
  SecurityRequirementObject,
  TagObject,
  ExternalDocumentationObject,
  ComponentsObject,
  ParameterLocation,
} from 'openapi3-ts';
import {
  ZodArray,
  ZodBoolean,
  ZodEnum,
  ZodIntersection,
  ZodLiteral,
  ZodNativeEnum,
  ZodNull,
  ZodNullable,
  ZodNumber,
  ZodObject,
  ZodOptional,
  ZodRawShape,
  ZodSchema,
  ZodString,
  ZodType,
  ZodTypeAny,
  ZodUnion,
} from 'zod';
import {
  compact,
  flatMap,
  isNil,
  isUndefined,
  mapValues,
  omit,
  omitBy,
} from 'lodash';
import { ZodOpenAPIMetadata } from './zod-extensions';
import { RouteConfig } from './router';

// See https://github.com/colinhacks/zod/blob/9eb7eb136f3e702e86f030e6984ef20d4d8521b6/src/types.ts#L1370
type UnknownKeysParam = 'passthrough' | 'strict' | 'strip';

type OpenAPIDefinitions =
  | { type: 'schema'; schema: ZodSchema<any> }
  | { type: 'parameter'; location: ParameterLocation; schema: ZodSchema<any> }
  | { type: 'route'; route: RouteConfig };

// This is essentially OpenAPIObject without the components and paths keys.
// Omit does not work, since OpenAPIObject extends ISpecificationExtension
// and is inferred as { [key: number]: any; [key: string]: any }
interface OpenAPIObjectConfig {
  openapi: string;
  info: InfoObject;
  servers?: ServerObject[];
  security?: SecurityRequirementObject[];
  tags?: TagObject[];
  externalDocs?: ExternalDocumentationObject;
}

export class OpenAPIGenerator {
  private schemaRefs: Record<string, SchemaObject> = {};
  private paramRefs: Record<string, ParameterObject> = {};
  private pathRefs: Record<string, Record<string, PathObject>> = {};

  constructor(
    private definitions: OpenAPIDefinitions[],
    private config?: OpenAPIObjectConfig
  ) {}

  generateDocs(): OpenAPIObject {
    if (!this.config) {
      throw new Error(
        'No config was provided when creating the OpenAPIGenerator'
      );
    }

    this.definitions.forEach((definition) => this.generateSingle(definition));

    return {
      ...this.config,
      components: {
        schemas: this.schemaRefs,
        parameters: this.paramRefs,
      },
      paths: this.pathRefs,
    };
  }

  generateComponents(): ComponentsObject {
    this.definitions.forEach((definition) => this.generateSingle(definition));

    return {
      components: {
        schemas: this.schemaRefs,
        parameters: this.paramRefs,
      },
    };
  }

  private generateSingle(
    definition: OpenAPIDefinitions
  ): SchemaObject | ParameterObject | ReferenceObject {
    if (definition.type === 'parameter') {
      return this.generateSingleParameter(
        definition.schema,
        definition.location,
        true
      );
    }

    if (definition.type === 'schema') {
      return this.generateSingleSchema(definition.schema, true);
    }

    if (definition.type === 'route') {
      return this.generateSingleRoute(definition.route);
    }

    throw new Error('Invalid definition type');
  }

  private generateSingleParameter(
    zodSchema: ZodSchema<any>,
    location: ParameterLocation,
    saveIfNew: boolean,
    externalName?: string
  ): ParameterObject | ReferenceObject {
    const metadata = this.getMetadata(zodSchema);

    /**
     * TODOs
     * External name should come as priority in case there is known schema?
     * Basically a schema is one thing, it's name in query is another.
     *
     * The externalName should not be a reason to "use it from the object".
     * An error should be thrown instead :thinking:
     */

    const schemaName = externalName ?? metadata?.name;

    if (!schemaName) {
      throw new Error(
        'Unknown parameter name, please specify `name` and other OpenAPI props using `ZodSchema.openapi`'
      );
    }

    if (this.paramRefs[schemaName]) {
      return {
        $ref: `#/components/parameters/${schemaName}`,
      };
    }

    const required = !zodSchema.isOptional() && !zodSchema.isNullable();

    const schema = this.generateSingleSchema(zodSchema, false, false);

    const result: ParameterObject = {
      in: location,
      name: schemaName,
      schema,
      required,
      // TODO: Fix types and check for possibly wrong data
      ...(metadata
        ? (this.buildMetadata(metadata) as Partial<ParameterObject>)
        : {}),
    };

    if (saveIfNew && schemaName) {
      this.paramRefs[schemaName] = result;
    }

    return result;
  }

  // TODO: Named parameters and smaller functions
  private generateSingleSchema(
    zodSchema: ZodSchema<any>,
    saveIfNew: boolean,
    withMetaData = true
  ): SchemaObject | ReferenceObject {
    const innerSchema = this.unwrapOptional(zodSchema);
    const metadata = zodSchema._def.openapi
      ? zodSchema._def.openapi
      : innerSchema._def.openapi;

    const schemaName = metadata?.name;

    if (schemaName && this.schemaRefs[schemaName]) {
      return {
        $ref: `#/components/schemas/${schemaName}`,
      };
    }

    const result = omitBy(
      {
        ...this.toOpenAPISchema(
          innerSchema,
          zodSchema.isNullable(),
          !!metadata?.type,
          saveIfNew
        ),
        ...(withMetaData && metadata ? this.buildMetadata(metadata) : {}),
      },
      isUndefined
    );

    if (saveIfNew && schemaName) {
      this.schemaRefs[schemaName] = result;
    }

    return result;
  }

  private getBodyDoc(
    bodySchema: ZodType<unknown> | undefined
  ): RequestBodyObject | undefined {
    if (!bodySchema) {
      return;
    }

    const schema = this.generateSingleSchema(bodySchema, false);
    const metadata = this.getMetadata(bodySchema);

    return {
      description: metadata?.description,
      required: true,
      content: {
        'application/json': {
          schema,
        },
      },
    };
  }

  private getParamsByLocation(
    paramsSchema: ZodType<unknown> | undefined,
    location: ParameterLocation
  ): (ParameterObject | ReferenceObject)[] {
    if (!paramsSchema) {
      return [];
    }

    // TODO: Should the paramsSchema be restricted to an object?
    if (paramsSchema instanceof ZodObject) {
      const propTypes = paramsSchema._def.shape() as ZodRawShape;

      return compact(
        Object.keys(propTypes).map((name) => {
          const propSchema = propTypes[name] as ZodTypeAny | undefined;

          if (!propSchema) {
            // Should not be happening
            return undefined;
          }

          return this.generateSingleParameter(
            propSchema,
            location,
            false,
            name
          );
        })
      );
    }

    return [];
  }

  private getParameters(
    request: RouteConfig['request'] | undefined
  ): (ParameterObject | ReferenceObject)[] {
    if (!request) {
      return [];
    }

    const pathParams = this.getParamsByLocation(request.params, 'path');
    const queryParams = this.getParamsByLocation(request.query, 'query');
    const headerParams = compact(
      request.headers?.map((header) =>
        this.generateSingleParameter(header, 'header', false)
      )
    );

    // What happens if a schema is defined as a parameter externally but is
    // used here as a header for example
    return [...pathParams, ...queryParams, ...headerParams];
  }

  private generateSingleRoute(route: RouteConfig) {
    const responseSchema = this.generateSingleSchema(route.response, false);

    const routeDoc: PathItemObject = {
      [route.method]: {
        description: route.description,
        summary: route.summary,

        // TODO: Header parameters
        parameters: this.getParameters(route.request),

        requestBody: this.getBodyDoc(route.request?.body),

        responses: {
          [200]: {
            description: route.response._def.openapi?.description,
            content: {
              'application/json': {
                schema: responseSchema,
              },
            },
          },
        },
      },
    };

    this.pathRefs[route.path] = {
      ...this.pathRefs[route.path],
      ...routeDoc,
    };

    return routeDoc;
  }

  private toOpenAPISchema(
    zodSchema: ZodSchema<any>,
    isNullable: boolean,
    hasOpenAPIType: boolean,
    saveIfNew: boolean
  ): SchemaObject {
    if (zodSchema instanceof ZodNull) {
      return { type: 'null' };
    }

    if (zodSchema instanceof ZodString) {
      return {
        type: 'string',
        nullable: isNullable ? true : undefined,
      };
    }

    if (zodSchema instanceof ZodNumber) {
      return {
        type: 'number',
        minimum: zodSchema.minValue ?? undefined,
        maximum: zodSchema.maxValue ?? undefined,
        nullable: isNullable ? true : undefined,
      };
    }

    if (zodSchema instanceof ZodLiteral) {
      return {
        type: typeof zodSchema._def.value as SchemaObject['type'],
        nullable: isNullable ? true : undefined,
        enum: [zodSchema._def.value],
      };
    }

    if (zodSchema instanceof ZodEnum) {
      // ZodEnum only accepts strings
      return {
        type: 'string',
        nullable: isNullable ? true : undefined,
        enum: zodSchema._def.values,
      };
    }

    if (zodSchema instanceof ZodNativeEnum) {
      const enumValues = Object.values(zodSchema._def.values);

      // ZodNativeEnum can accepts number values for enum but in odd format
      // Not worth it for now so using plain string
      return {
        type: 'string',
        nullable: isNullable ? true : undefined,
        enum: enumValues,
      };
    }

    if (zodSchema instanceof ZodObject) {
      const propTypes = zodSchema._def.shape() as ZodRawShape;
      const unknownKeysOption = zodSchema._unknownKeys as UnknownKeysParam;

      return {
        type: 'object',

        properties: mapValues(propTypes, (propSchema) =>
          this.generateSingleSchema(propSchema, saveIfNew)
        ),

        required: Object.entries(propTypes)
          .filter(([_key, type]) => !type.isOptional())
          .map(([key, _type]) => key),

        additionalProperties: unknownKeysOption === 'passthrough' || undefined,

        nullable: isNullable ? true : undefined,
      };
    }

    if (zodSchema instanceof ZodBoolean) {
      return {
        type: 'boolean',
        nullable: isNullable ? true : undefined,
      };
    }

    if (zodSchema instanceof ZodArray) {
      const itemType = zodSchema._def.type as ZodSchema<any>;

      return {
        type: 'array',
        items: this.generateSingleSchema(itemType, saveIfNew),

        minItems: zodSchema._def.minLength?.value,
        maxItems: zodSchema._def.maxLength?.value,
      };
    }

    if (zodSchema instanceof ZodUnion) {
      const options = this.flattenUnionTypes(zodSchema);

      return {
        anyOf: options.map((schema) =>
          this.generateSingleSchema(schema, saveIfNew)
        ),
      };
    }

    if (zodSchema instanceof ZodIntersection) {
      const subtypes = this.flattenIntersectionTypes(zodSchema);

      return {
        allOf: subtypes.map((schema) =>
          this.generateSingleSchema(schema, saveIfNew)
        ),
      };
    }

    if (hasOpenAPIType) {
      return {};
    }

    // TODO: Better error name (so that a random build of 100 schemas can be traced)
    throw new Error(
      'Unknown zod object type, please specify `type` and other OpenAPI props using `ZodSchema.openapi`' +
        JSON.stringify(zodSchema._def)
    );
  }

  private flattenUnionTypes(schema: ZodSchema<any>): ZodSchema<any>[] {
    if (!(schema instanceof ZodUnion)) {
      return [schema];
    }

    const options = schema._def.options as ZodSchema<any>[];

    return flatMap(options, (option) => this.flattenUnionTypes(option));
  }

  private flattenIntersectionTypes(schema: ZodSchema<any>): ZodSchema<any>[] {
    if (!(schema instanceof ZodIntersection)) {
      return [schema];
    }

    const leftSubTypes = this.flattenIntersectionTypes(schema._def.left);
    const rightSubTypes = this.flattenIntersectionTypes(schema._def.right);

    return [...leftSubTypes, ...rightSubTypes];
  }

  private unwrapOptional(schema: ZodSchema<any>): ZodSchema<any> {
    while (schema instanceof ZodOptional || schema instanceof ZodNullable) {
      schema = schema.unwrap();
    }

    return schema;
  }

  private buildMetadata(metadata: ZodOpenAPIMetadata): Partial<SchemaObject> {
    return omitBy(omit(metadata, 'name'), isNil);
  }

  private getMetadata(zodSchema: ZodSchema<any>) {
    const innerSchema = this.unwrapOptional(zodSchema);
    const metadata = zodSchema._def.openapi
      ? zodSchema._def.openapi
      : innerSchema._def.openapi;

    return metadata;
  }
}
