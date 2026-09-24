/**
 * Consumer-shaped hello world. Keep in sync with the README "Hello world" block.
 * Typechecked by the repo `tsc --noEmit` (not executed).
 */
import "reflect-metadata";
import {
    App,
    ArcheType,
    ArcheTypeField,
    BaseArcheType,
    BaseComponent,
    BaseService,
    Component,
    CompData,
    Entity,
    GraphQLOperation,
    Query,
    ServiceRegistry,
    t,
    type InferInput,
} from "bunsane";

@Component
class Note extends BaseComponent {
    @CompData() text: string = "";
}

@ArcheType()
class Notebook extends BaseArcheType {
    @ArcheTypeField(Note) note!: Note;
}

const noteInput = { text: t.string().required() };

class NoteService extends BaseService {
    @GraphQLOperation({ type: "Query", input: noteInput, output: "Notebook" })
    notes(input: InferInput<typeof noteInput>): Promise<unknown> | unknown {
        const entity = Entity.Create();
        entity.add(Note, { text: input.text });
        return entity.save().then(() => new Query().with(Note).populate().take(10).exec());
    }
}

const app = new App("Hello", "0.1.0");
ServiceRegistry.registerService(new NoteService());
// init() migrates, builds the schema, and listens (unless NODE_ENV=test).
await app.init();
