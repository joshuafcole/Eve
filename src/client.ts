import {clone, debounce, uuid, sortComparator} from "./util";
import {sentInputValues, activeIds, renderRecords, renderEve} from "./renderer"
import {IDE} from "./ide";
import * as browser from "./runtime/browser";

import {IndexScalar, IndexList, EAV, Record} from "./db"

//---------------------------------------------------------
// Utilities
//---------------------------------------------------------
function safeEav(eav:[any, any, any]):EAV {
  if(eav[0].type == "uuid")  {
    eav[0] = `⦑${eav[0].value}⦒`
  }
  if(eav[1].type == "uuid")  {
    eav[1] = `⦑${eav[1].value}⦒`
  }
  if(eav[2].type == "uuid")  {
    eav[2] = `⦑${eav[2].value}⦒`
  }
  return eav;
}

function recordToEAVs(record) {
  if(!record) return;
  let eavs:EAV[] = [];
  if(record.id && record.id.constructor === Array) throw new Error("Unable to apply multiple ids to the same record: " + JSON.stringify(record));
  if(!record.id) record.id = uuid();
  record.id = "" + record.id + "";
  let e = record.id;

  for(let a in record) {
    if(record[a] === undefined) continue;
    if(a === "id") continue;
    if(record[a].constructor === Array) {
      for(let v of record[a]) {
        if(typeof v === "object") {
          eavs.push.apply(eavs, recordToEAVs(v));
          eavs.push([e, a, v.id]);
        } else {
          eavs.push([e, a, v]);
        }
      }
    } else {
      let v = record[a];
      if(typeof v === "object") {
        eavs.push.apply(eavs, recordToEAVs(v));
        eavs.push([e, a, v.id]);
      } else {
        eavs.push([e, a, v]);
      }
    }
  }
  return eavs;
}

function onHashChange(event) {
  let hash = window.location.hash.substr(1);
  if(hash[0] == "/") hash = hash.substr(1);

  if(hash) {
    let segments = hash.split("/").map(function(seg, ix) {
      return {id: uuid(), index: ix + 1, value: seg};
    });

    connection.sendEvent([
      {tag: "url-change", "hash-segment": segments}
    ]);
  }
}

window.addEventListener("hashchange", onHashChange);


//---------------------------------------------------------
// Connection
//---------------------------------------------------------

interface Socket {
  readyState: number
  send(message:string)
  onopen?: (open?:Event) => void
  onclose?: (close?:CloseEvent) => void
  onmessage?: (message:MessageEvent) => void
  onerror?: (error:ErrorEvent) => void
}

class Connection {
  static createLocalSocket():Socket {
    return {
      readyState: 1,
      send: (json) => {
        browser.responder.handleEvent(json);
      }
    }
  }

  static createRemoteSocket():Socket {
    if(location.protocol.indexOf("https") > -1) {
      return new WebSocket("wss://" + window.location.host +"/ws");
    } else {
      return new WebSocket("ws://" + window.location.host +"/ws");
    }
  }

  prerendering = false;
  pingTimer:NodeJS.Timer|undefined;

  socket:Socket;

  indexes = {
    records: new IndexScalar<Record>(), // E -> Record
    dirty: new IndexList<string>(),     // E -> A
    byName: new IndexList<string>(),    // name -> E
    byTag: new IndexList<string>(),     // tag -> E

    // renderer indexes
    byClass: new IndexList<string>(),   // class -> E
    byStyle: new IndexList<string>(),   // style -> E
    byChild: new IndexScalar<string>()  // child -> E
  };

  constructor(local = false) {
    this.indexes.dirty.subscribe(this.renderOnChange);
    this.indexes.dirty.subscribe(this.printDebugRecords);

    if(local) {
      this.socket = Connection.createLocalSocket();
      browser.init(global["code"]);
    } else {
      this.socket = Connection.createRemoteSocket();
    }
    this.socket.onopen = this.onopen;
    this.socket.onclose = this.onclose;
    this.socket.onmessage = this.onmessage;
  }

  get connected() {
    return this.socket && this.socket.readyState === 1;
  }

  // @TODO: Queue when disconnected.
  send(message) {
    if(this.connected) {
      this.socket.send(JSON.stringify(message));
    }
  }

  sendEvent(records:any[]) {
    if(!records || !records.length) return;
    let eavs = [];
    for(let record of records) {
      eavs.push.apply(eavs, recordToEAVs(record));
    }
    this.send({type: "event", insert: eavs});
  }

  sendParse(generation:number, code:string) {
    this.send({scope: "root", type: "parse", generation, code});
  }

  sendEval(persist = false) {
    this.send({type: "eval", persist});
  }

  sendClose() {
    this.send({type: "close"});
  }

  handleDiff(diff) {
    let diffEntities = 0;
    let entitiesWithUpdatedValues = {};

    let indexes = this.indexes;
    let records = indexes.records;
    let dirty = indexes.dirty;

    for(let remove of diff.remove) {
      let [e, a, v] = safeEav(remove);
      if(!records.index[e]) {
        console.error(`Attempting to remove an attribute of an entity that doesn't exist: ${e}`);
        continue;
      }

      let entity = records.index[e];
      let values = entity[a];
      if(!values) continue;
      dirty.insert(e, a);

      if(values.length <= 1 && values[0] === v) {
        delete entity[a];
      } else {
        let ix = values.indexOf(v);
        if(ix === -1) continue;
        values.splice(ix, 1);
      }

      // Update indexes
      if(a === "tag") indexes.byTag.remove(v, e);
      else if(a === "name") indexes.byName.remove(v, e);
      else if(a === "class") indexes.byClass.remove(v, e);
      else if(a === "style") indexes.byStyle.remove(v, e);
      else if(a === "children") indexes.byChild.remove(v, e);
      else if(a === "value") entitiesWithUpdatedValues[e] = true;

    }

    for(let insert of diff.insert) {
      let [e, a, v] = safeEav(insert);
      let entity = records.index[e];
      if(!entity) {
        entity = {};
        records.insert(e, entity);
        diffEntities++; // Nuke this and use records.dirty
      }

      dirty.insert(e, a);

      if(!entity[a]) entity[a] = [];
      entity[a].push(v);

      // Update indexes
      if(a === "tag") indexes.byTag.insert(v, e);
      else if(a === "name") indexes.byName.insert(v, e);
      else if(a === "class") indexes.byClass.insert(v, e);
      else if(a === "style") indexes.byStyle.insert(v, e);
      else if(a === "children") indexes.byChild.insert(v, e);
      else if(a === "value") entitiesWithUpdatedValues[e] = true;
    }

    // Update value syncing
    for(let e in entitiesWithUpdatedValues) {
      let a = "value";
      let entity = records.index[e];
      if(!entity[a]) {
        sentInputValues[e] = [];
      } else {
        if(entity[a].length > 1) console.error("Unable to set 'value' multiple times on entity", e, entity[a]);
        let value = entity[a][0];
        let sent = sentInputValues[e];
        if(sent && sent[0] === value) {
          dirty.remove(e, a);
          sent.shift();
        } else {
          sentInputValues[e] = [];
        }
      }
    }
    // Trigger all the subscribers of dirty indexes
    for(let indexName in indexes) {
      indexes[indexName].dispatchIfDirty();
    }
    // Clear dirty states afterwards so a subscriber of X can see the dirty state of Y reliably
    for(let indexName in indexes) {
      indexes[indexName].clearDirty();
    }
    // Finally, wipe the dirty E -> A index
    indexes.dirty.clearIndex();
  }

  // Handlers
  onopen = () => {
    console.log("Connected to eve server!");
    this.socket.send(JSON.stringify({type: "init", url: location.pathname}))
    onHashChange({});
    this.pingTimer = setInterval(() => {
      this.socket.send("\"PING\"");
    }, 30000);
  }

  onclose = () => {
    console.log("Disconnected from eve server!");
    if(this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  onmessage = (msg) => {
    let data = JSON.parse(msg.data);
    let indexes = this.indexes;
    if(data.type == "result") {
      let state = {entities: indexes.records.index, dirty: indexes.dirty.index};
      this.handleDiff(data);

      let diffEntities = 0;
      if(DEBUG) {
        console.groupCollapsed(`Received Result +${data.insert.length}/-${data.remove.length} (∂Entities: ${diffEntities})`);
        if(DEBUG === true || DEBUG === "diff") {
          console.table(data.insert);
          console.table(data.remove);
        }
        if(DEBUG === true || DEBUG === "state") {
          // we clone here to keep the entities fresh when you want to thumb through them in the log later (since they are rendered lazily)
          let copy = clone(state.entities);

          console.log("Entities", copy);
          console.log("Indexes", indexes);
        }
        console.groupEnd();
      }

      if(document.readyState === "complete") {
        renderEve();
      } else if(!this.prerendering) {
        this.prerendering = true;
        document.addEventListener("DOMContentLoaded", () => renderEve());
      }
    } else if(data.type == "initLocal") {
      this.socket = Connection.createLocalSocket();
      this.socket.onopen = this.onopen;
      this.socket.onclose = this.onclose;
      this.socket.onmessage = this.onmessage;
      browser.init(data.code);

    } else if(data.type == "parse") {
      _ide.loadDocument(data.generation, data.text, data.spans, data.extraInfo); // @FIXME

    } else if(data.type == "error") {
      console.error(data.message, data);
    }
  }

  // Subscribers
  renderOnChange = (index, dirty) => {
    renderRecords();
  }

  printDebugRecords = (index, dirty) => {
    for(let recordId in dirty) {
      let record = this.indexes.records.index[recordId];
      if(record.tag && record.tag.indexOf("debug") !== -1) {
        console.info(record);
      }
    }
  }
}

//---------------------------------------------------------
// File Store
//---------------------------------------------------------

interface FileNode {id: string, name: string, type: "document"|"folder", content?: string, children?: string[], readonly?: boolean}
class FileStore {
  protected static _version = 1;

  protected static _parse(raw:string):{[id:string]: FileNode} {
    let files:{[fileId:string]:FileNode} = {root: {id: "root", name: "", type: "folder"}};
    if(!raw) return files;
    let parsed = JSON.parse(raw);
    if(parsed.$$version !== FileStore._version) throw new Error("Unable to parse unknown file store version.");
    return parsed;
  }

  protected static _stringify(files:{[id:string]: FileNode}):string {
    let obj = {$$version: FileStore._version};
    for(let fileId in files) {
      if(files[fileId].readonly) continue;

      obj[fileId] = files[fileId];
    }
    return JSON.stringify(obj);
  }

  protected _files:{[id:string]: FileNode|undefined} = {};

  constructor(public key: string) {
    this.reload();
  }

  reload() {
    this._files = FileStore._parse(localStorage.getItem(this.key));
  }
  sync() {
    localStorage.setItem(this.key, FileStore._stringify(this._files));
  }

  updateContent(fileId:string, content: string) {
    let file = this._files[fileId];
    if(!file) throw new Error(`Unable to update nonexistent file with id '${fileId}'`);
    if(file.readonly) throw new Error(`Unable to update readonly document '${fileId}'`);
    file.content = content;
    this.sync();
  }

  getFileById(fileId:string):FileNode|undefined {
    return this._files[fileId];
  }

  createFolder(name:string, parentId = "root", readonly = false):string {
    let parent = this._files[parentId];
    if(!parent) throw new Error(`Unable to create folder in nonexistent parent with id ${parentId}`);
    let fileId = parentId + "/" + name;

    let file:FileNode = {id: fileId, name, type: "folder", readonly: readonly || parent.readonly};
    this._files[fileId] = file;
    this.sync();

    return fileId;
  }

  createDocument(name:string, content: string, parentId = "root"):string {
    let parent = this._files[parentId];
    if(!parent) throw new Error(`Unable to create document in nonexistent parent with id ${parentId}`);
    let fileId = parentId + "/" + name;

    let file:FileNode = {id: fileId, name, type: "document", content, readonly: parent.readonly};
    this._files[fileId] = file;
    this.sync();

    return fileId;
  }

  deleteNode(fileId:string, cascading = false) {
    let node = this._files[fileId];
    if(!node) return;
    if(node.readonly) throw new Error(`Unable to delete readonly ${node.type} with id '${fileId}'`);
    if(node.children) {
      for(let childId of node.children) {
        this.deleteNode(childId, true);
      }
    }
    delete this._files[fileId];
    this.sync();
  }
}

function buildFileStore():FileStore {
  let fileStore = new FileStore("eve");
  let examples = window["examples"];

  if(!examples) {
    console.error("Please run node build/scripts/package-examples.js to enable navigating to examples from within the IDE.");
  } else {
    let examplesId = fileStore.createFolder("examples", "root", true);
    for(let fileName in examples) {
      fileStore.createDocument(fileName, examples[fileName], examplesId);
    }
  }

  return fileStore;
}

//---------------------------------------------------------
// Kick off the client
//---------------------------------------------------------
export var DEBUG:string|boolean = false;

export let connection = new Connection(global["local"]);
let fileStore = buildFileStore();


let _ide = new IDE();
_ide.documentId = location.pathname.split("/").pop();
_ide.render();
_ide.loadWorkspace("examples", "examples", window["examples"]);
console.log(_ide);
_ide.onChange = (ide:IDE) => {
  let generation = ide.generation;
  let md = ide.editor.toMarkdown();
  connection.sendParse(generation, md);
  console.groupCollapsed(`SENT ${generation}`);
  console.info(md);
  console.groupEnd();

}
_ide.onEval = (ide:IDE, persist) => {

}
_ide.onLoadFile = (ide, documentId, code) => {
  connection.sendClose();
  connection.sendParse(ide.generation, code);
  connection.sendEval(false);
  history.replaceState({}, "", `/examples/${documentId}`);
}
