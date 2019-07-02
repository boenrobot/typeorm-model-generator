import {
    WithLengthColumnType,
    WithPrecisionColumnType,
    WithWidthColumnType
} from "typeorm/driver/types/ColumnTypes";
import { DataTypeDefaults } from "typeorm/driver/types/DataTypeDefaults";
import { IConnectionOptions } from "../IConnectionOptions";
import { ColumnInfo } from "../models/ColumnInfo";
import { EntityInfo } from "../models/EntityInfo";
import { IndexInfo } from "../models/IndexInfo";
import { RelationInfo } from "../models/RelationInfo";
import { IRelationTempInfo } from "../models/RelationTempInfo";
import * as TomgUtils from "../Utils";

export abstract class AbstractDriver {
    public abstract standardPort: number;
    public abstract standardSchema: string;
    public abstract standardUser: string;
    public abstract defaultValues: DataTypeDefaults;

    public ColumnTypesWithWidth: WithWidthColumnType[] = [
        "tinyint",
        "smallint",
        "mediumint",
        "int",
        "bigint"
    ];
    public ColumnTypesWithPrecision: WithPrecisionColumnType[] = [
        "float",
        "double",
        "dec",
        "decimal",
        "numeric",
        "real",
        "double precision",
        "number",
        "datetime",
        "datetime2",
        "datetimeoffset",
        "time",
        "time with time zone",
        "time without time zone",
        "timestamp",
        "timestamp without time zone",
        "timestamp with time zone",
        "timestamp with local time zone"
    ];
    public ColumnTypesWithLength: WithLengthColumnType[] = [
        "character varying",
        "varying character",
        "nvarchar",
        "character",
        "native character",
        "varchar",
        "char",
        "nchar",
        "varchar2",
        "nvarchar2",
        "raw",
        "binary",
        "varbinary"
    ];

    public abstract GetAllTablesQuery: (
        schema: string,
        dbNames: string
    ) => Promise<
        Array<{
            TABLE_SCHEMA: string;
            TABLE_NAME: string;
            DB_NAME: string;
        }>
    >;

    public FindManyToManyRelations(dbModel: EntityInfo[]) {
        const manyToManyEntities = dbModel.filter(
            entity =>
                entity.Columns.filter(column => {
                    return (
                        column.relations.length === 1 &&
                        !column.relations[0].isOneToMany &&
                        column.relations[0].isOwner
                    );
                }).length === entity.Columns.length
        );
        manyToManyEntities.map(entity => {
            let relations: RelationInfo[] = [];
            relations = entity.Columns.reduce(
                (prev: RelationInfo[], curr) => prev.concat(curr.relations),
                relations
            );
            const namesOfRelatedTables = relations
                .map(v => v.relatedTable)
                .filter((v, i, s) => s.indexOf(v) === i);
            if (namesOfRelatedTables.length === 2) {
                const relatedTable1 = dbModel.find(
                    v => v.tsEntityName === namesOfRelatedTables[0]
                )!;
                relatedTable1.Columns = relatedTable1.Columns.filter(
                    v =>
                        !v.tsName
                            .toLowerCase()
                            .startsWith(entity.tsEntityName.toLowerCase())
                );
                const relatedTable2 = dbModel.find(
                    v => v.tsEntityName === namesOfRelatedTables[1]
                )!;
                relatedTable2.Columns = relatedTable2.Columns.filter(
                    v =>
                        !v.tsName
                            .toLowerCase()
                            .startsWith(entity.tsEntityName.toLowerCase())
                );
                dbModel = dbModel.filter(ent => {
                    return ent.tsEntityName !== entity.tsEntityName;
                });

                const column1 = new ColumnInfo();
                column1.tsName = namesOfRelatedTables[1];
                column1.options.name = entity.sqlEntityName;

                const col1Rel = new RelationInfo();
                col1Rel.relatedTable = namesOfRelatedTables[1];
                col1Rel.relatedColumn = namesOfRelatedTables[1];

                col1Rel.relationType = "ManyToMany";
                col1Rel.isOwner = true;
                col1Rel.ownerColumn = namesOfRelatedTables[0];

                column1.relations.push(col1Rel);
                relatedTable1.Columns.push(column1);

                const column2 = new ColumnInfo();
                column2.tsName = namesOfRelatedTables[0];

                const col2Rel = new RelationInfo();
                col2Rel.relatedTable = namesOfRelatedTables[0];
                col2Rel.relatedColumn = namesOfRelatedTables[1];

                col2Rel.relationType = "ManyToMany";
                col2Rel.isOwner = false;
                column2.relations.push(col2Rel);
                relatedTable2.Columns.push(column2);
            }
        });
        return dbModel;
    }
    public async GetDataFromServer(
        connectionOptons: IConnectionOptions
    ): Promise<EntityInfo[]> {
        let dbModel: EntityInfo[];
        await this.ConnectToServer(connectionOptons);
        const sqlEscapedSchema = this.escapeCommaSeparatedList(
            connectionOptons.schemaName
        );
        dbModel = await this.GetAllTables(
            sqlEscapedSchema,
            connectionOptons.databaseName
        );
        await this.GetCoulmnsFromEntity(
            dbModel,
            sqlEscapedSchema,
            connectionOptons.databaseName
        );
        await this.GetIndexesFromEntity(
            dbModel,
            sqlEscapedSchema,
            connectionOptons.databaseName
        );
        dbModel = await this.GetRelations(
            dbModel,
            sqlEscapedSchema,
            connectionOptons.databaseName
        );
        await this.DisconnectFromServer();
        dbModel = this.FindManyToManyRelations(dbModel);
        this.FindPrimaryColumnsFromIndexes(dbModel);
        return dbModel;
    }

    public abstract async ConnectToServer(connectionOptons: IConnectionOptions);

    public async GetAllTables(
        schema: string,
        dbNames: string
    ): Promise<EntityInfo[]> {
        const response = await this.GetAllTablesQuery(schema, dbNames);
        const ret: EntityInfo[] = [] as EntityInfo[];
        response.forEach(val => {
            const ent: EntityInfo = new EntityInfo();
            ent.tsEntityName = val.TABLE_NAME;
            ent.sqlEntityName = val.TABLE_NAME;
            ent.Schema = val.TABLE_SCHEMA;
            ent.Columns = [] as ColumnInfo[];
            ent.Indexes = [] as IndexInfo[];
            ent.Database = dbNames.includes(",") ? val.DB_NAME : "";
            ret.push(ent);
        });
        return ret;
    }

    public GetRelationsFromRelationTempInfo(
        relationsTemp: IRelationTempInfo[],
        entities: EntityInfo[]
    ) {
        relationsTemp.forEach(relationTmp => {
            const ownerEntity = entities.find(
                entitity => entitity.tsEntityName === relationTmp.ownerTable
            );
            if (!ownerEntity) {
                TomgUtils.LogError(
                    `Relation between tables ${relationTmp.ownerTable} and ${
                        relationTmp.referencedTable
                    } didn't found entity model ${relationTmp.ownerTable}.`
                );
                return;
            }
            const referencedEntity = entities.find(
                entitity =>
                    entitity.tsEntityName === relationTmp.referencedTable
            );
            if (!referencedEntity) {
                TomgUtils.LogError(
                    `Relation between tables ${relationTmp.ownerTable} and ${
                        relationTmp.referencedTable
                    } didn't found entity model ${relationTmp.referencedTable}.`
                );
                return;
            }

            const correspondingIndex = referencedEntity.Indexes.find(
                (index: IndexInfo) =>
                    index.columns.length >=
                        relationTmp.referencedColumnsNames.length &&
                    relationTmp.referencedColumnsNames.every(
                        (name: string, i: number) =>
                            name === index.columns[i].name
                    )
            );

            if (!correspondingIndex) {
                TomgUtils.LogError(
                    `Relation between tables ${relationTmp.ownerTable} and ${
                        relationTmp.referencedTable
                    } didn't found a corresponding index in ${
                        relationTmp.referencedTable
                    } for ${relationTmp.object_id}.`
                );
                return;
            }
            let relatedColumn:
                | ColumnInfo
                | undefined = referencedEntity.Columns.find(
                (col: ColumnInfo) => col.tsName === correspondingIndex.name
            );
            if (!relatedColumn) {
                relatedColumn = new ColumnInfo();
                relatedColumn.tsName = correspondingIndex.name;
                referencedEntity.Columns.push(relatedColumn);
            }

            const ownerRelation = new RelationInfo();
            ownerRelation.isOwner = true;
            ownerRelation.actionOnDelete = relationTmp.actionOnDelete;
            ownerRelation.actionOnUpdate = relationTmp.actionOnUpdate;
            ownerRelation.relatedTable = relationTmp.referencedTable;
            ownerRelation.ownerTable = relationTmp.ownerTable;
            ownerRelation.ownerColumn = relationTmp.object_id.toString();
            ownerRelation.relatedColumn = correspondingIndex.name;
            const isOneToMany =
                correspondingIndex.isPrimaryKey || correspondingIndex.isUnique;
            ownerRelation.relationType = isOneToMany ? "ManyToOne" : "OneToOne";
            ownerRelation.sqlOwnerColumns = relationTmp.ownerColumnsNames;
            ownerRelation.sqlRelatedColumns =
                relationTmp.referencedColumnsNames;

            const ownerColumn = new ColumnInfo();
            ownerColumn.tsName = ownerRelation.ownerColumn;
            ownerColumn.relations.push(ownerRelation);
            ownerEntity.Columns.push(ownerColumn);

            const referencedRelation = new RelationInfo();
            relatedColumn.relations.push(referencedRelation);
            referencedRelation.actionOnDelete = relationTmp.actionOnDelete;
            referencedRelation.actionOnUpdate = relationTmp.actionOnUpdate;
            referencedRelation.isOwner = false;
            referencedRelation.relatedTable = relationTmp.ownerTable;
            referencedRelation.ownerTable = relationTmp.referencedTable;
            referencedRelation.ownerColumn = ownerRelation.relatedColumn;
            referencedRelation.relatedColumn = ownerRelation.ownerColumn;
            referencedRelation.sqlRelatedColumns =
                relationTmp.ownerColumnsNames;
            referencedRelation.sqlOwnerColumns =
                relationTmp.referencedColumnsNames;
            referencedRelation.relationType = isOneToMany
                ? "OneToMany"
                : "OneToOne";
        });
        return entities;
    }
    public abstract async GetCoulmnsFromEntity(
        entities: EntityInfo[],
        schema: string,
        dbNames: string
    ): Promise<EntityInfo[]>;
    public abstract async GetIndexesFromEntity(
        entities: EntityInfo[],
        schema: string,
        dbNames: string
    ): Promise<EntityInfo[]>;
    public abstract async GetRelations(
        entities: EntityInfo[],
        schema: string,
        dbNames: string
    ): Promise<EntityInfo[]>;

    public FindPrimaryColumnsFromIndexes(dbModel: EntityInfo[]) {
        dbModel.forEach(entity => {
            const primaryIndex = entity.Indexes.find(v => v.isPrimaryKey);
            entity.Columns.filter(
                col =>
                    primaryIndex &&
                    primaryIndex.columns.some(
                        cIndex => cIndex.name === col.tsName
                    )
            ).forEach(col => (col.options.primary = true));
            if (
                !entity.Columns.some(v => {
                    return !!v.options.primary;
                })
            ) {
                TomgUtils.LogError(
                    `Table ${entity.tsEntityName} has no PK.`,
                    false
                );
                return;
            }
        });
    }
    public abstract async DisconnectFromServer();
    public abstract async CreateDB(dbName: string);
    public abstract async DropDB(dbName: string);
    public abstract async UseDB(dbName: string);
    public abstract async CheckIfDBExists(dbName: string): Promise<boolean>;

    // TODO: change name
    protected escapeCommaSeparatedList(commaSeparatedList: string) {
        return "'" + commaSeparatedList.split(",").join("','") + "'";
    }
}
