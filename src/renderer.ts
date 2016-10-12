"use strict"

import {Renderer} from "microReact";
import {clone} from "./util";
import {connection} from "./client";

//type RecordElementCollection = HTMLCollection | SVGColl
interface RecordElement extends Element { entity?: string, sort?: any, _parent?: RecordElement|null, style?: CSSStyleDeclaration };
interface RDocument extends Document { activeElement: RecordElement };
declare var document: RDocument;

function isInputElem<T extends Element>(elem:T): elem is T&HTMLInputElement {
  return elem && elem.tagName === "INPUT";
}
function isSelectElem<T extends Element>(elem:T): elem is T&HTMLSelectElement {
  return elem && elem.tagName === "SELECT";
}

export function setActiveIds(ids) {
  for(let k in activeIds) {
    activeIds[k] = undefined;
  }
  for(let k in ids) {
    activeIds[k] = ids[k];
  }
}


//---------------------------------------------------------
// MicroReact-based record renderer
//---------------------------------------------------------
export var renderer = new Renderer();
document.body.appendChild(renderer.content);
renderer.content.classList.add("application-root");

// These will get maintained by the client as diffs roll in
export var sentInputValues = {};
export var activeIds = {};

// root will get added to the dom by the program microReact element in renderEditor
export var activeElements:{[id : string]: RecordElement|null, root: RecordElement} = {"root": document.createElement("div")};
activeElements.root.className = "program";

var supportedTags = {
  "div": true, "span": true, "input": true, "ul": true, "li": true, "label": true, "button": true, "header": true, "footer": true, "a": true, "strong": true,
  "h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true,
  "ol": true, "p": true, "pre": true, "em": true, "img": true, "canvas": true, "script": true, "style": true, "video": true,
  "table": true, "tbody": true, "thead": true, "tr": true, "th": true, "td": true,
  "form": true, "optgroup": true, "option": true, "select": true, "textarea": true,
  "title": true, "meta": true, "link": true,
  "svg": true, "circle": true, "line": true, "rect": true, "polygon":true, "text": true, "image": true, "defs": true, "pattern": true, "linearGradient": true, "g": true, "path": true
};
var svgs = {"svg": true, "circle": true, "line": true, "rect": true, "polygon":true, "text": true, "image": true, "defs": true, "pattern": true, "linearGradient": true, "g": true, "path": true};
// Map of input entities to a queue of their values which originated from the client and have not been received from the server yet.

var lastFocusPath:string[]|null = null;
var selectableTypes = {"": true, undefined: true, text: true, search: true, password: true, tel: true, url: true};

function insertSorted(parent:Node, child:RecordElement) {
  let current;
  for(let curIx = 0; curIx < parent.childNodes.length; curIx++) {
    let cur = parent.childNodes[curIx] as RecordElement;
    if(cur.sort !== undefined && cur.sort > child.sort) {
      current = cur;
      break;
    }
  }
  if(current) {
    parent.insertBefore(child, current);
  } else  {
    parent.appendChild(child);
  }
}

let _suppressBlur = false; // This global is set when the records are being re-rendered, to prevent false blurs from mucking up focus tracking.

export function renderRecords() {
  _suppressBlur = true;
  let lastActiveElement:RecordElement|null = null;
  if(document.activeElement && document.activeElement.entity) {
    lastActiveElement = document.activeElement;
  }

  let indexes = connection.indexes;
  let records = indexes.records.index;
  let dirty = indexes.dirty.index;
  let activeClasses = indexes.byClass.index || {};
  let activeStyles = indexes.byStyle.index || {};
  let activeChildren = indexes.byChild.index || {};

  let regenClassesFor:string[] = [];
  let regenStylesFor:string[] = [];

  for(let entityId in dirty) {
    let entity = records[entityId];
    let elem:RecordElement|null = activeElements[entityId];

    if(dirty[entityId].indexOf("tag") !== -1) {
      let values = entity.tag || []
      let tag;
      for(let val of values) {
        if(supportedTags[val]) {
          if(tag) console.error("Unable to set 'tag' multiple times on entity", entity, entity.tag);
          tag = val;
        }
      }

      if(!tag && elem && elem !== activeElements.root) { // Nuke the element if it no longer has a supported tag
        let parent = elem.parentNode;
        if(parent) parent.removeChild(elem);
        elem = activeElements[entityId] = null;

      } else if(tag && elem && elem.tagName !== tag.toUpperCase()) { // Nuke and restore the element if its tag has changed
        let parent = elem.parentNode;
        if(parent) parent.removeChild(elem);
        if(svgs[tag]) {
          elem = document.createElementNS("http://www.w3.org/2000/svg", tag) as RecordElement;
        } else {
          elem = document.createElement(tag || "div")
        }
        // Mark all attributes of the entity dirty to rerender them into the new element
        for(let attribute in entity) {
          if(dirty[entityId].indexOf(attribute) == -1) {
            dirty[entityId].push(attribute);
          }
        }
        elem.entity = entityId;
        activeElements[entityId] = elem;
        elem.sort = entity.sort || entity["eve-auto-index"] || "";
        if(parent) insertSorted(parent, elem)


      } else if(tag && !elem) { // Create a new element and mark all its attributes dirty to restore it.
        if(svgs[tag]) {
          elem = document.createElementNS("http://www.w3.org/2000/svg", tag);
        } else {
          elem = document.createElement(tag || "div")
        }
        elem.entity = entityId;
        activeElements[entityId] = elem;
        if(entity.sort && entity.sort.length > 1) console.error("Unable to set 'sort' multiple times on entity", entity, entity.sort);
        elem.sort = (entity.sort && entity.sort[0]) || (entity["eve-auto-index"] && entity["eve-auto-index"][0]) || "";
        let parent = activeElements[activeChildren[entityId] || "root"];
        if(parent) {
          insertSorted(parent, elem)
        }
      }
    }

    if(activeClasses[entityId]) {
      for(let entId of activeClasses[entityId]) {
        regenClassesFor.push(entId);
      }
    } else if(activeStyles[entityId]) {
      for(let entId of activeStyles[entityId]) {
        regenStylesFor.push(entId);
      }
    }

    if(!elem) continue;

    for(let attribute of dirty[entityId]) {
      let value = entity[attribute];

      if(attribute === "children") {
        if(!value) { // Remove all children
          while(elem.lastElementChild) {
            elem.removeChild(elem.lastElementChild);
          }
        } else {
          let children = (value && clone(value)) || [];
          // Remove any children that no longer belong
          for(let ix = elem.childNodes.length - 1; ix >= 0; ix--) {
            if(!(elem.childNodes[ix] instanceof Element)) continue;
            let child = elem.childNodes[ix] as RecordElement;
            let childIx = children.indexOf(child.entity);
            if(childIx == -1) {
              elem.removeChild(child);
              child._parent = null;
            } else {
              children.splice(childIx, 1);
            }
          }
          // Add any new children which already exist
          for(let childId of children) {
            let child = activeElements[childId];
            if(child) {
              insertSorted(elem, child);
            }
          }
        }
      } else if(attribute === "class") {
        regenClassesFor.push(entityId);

      } else if(attribute === "style") {
        regenStylesFor.push(entityId);

      } else if(attribute === "text") {
        elem.textContent = (value && value.join(", ")) || "";

      } else if(attribute === "value") {
        let input = elem as (RecordElement & HTMLInputElement);
        if(!value) {
          input.value = "";
        } else if(value.length > 1) {
          console.error("Unable to set 'value' multiple times on entity", entity, JSON.stringify(value));
        } else {
          input.value = value[0]; // @FIXME: Should this really be setAttribute?
        }

      } else if(attribute === "checked") {
        if(value && value.length > 1) {
          console.error("Unable to set 'checked' multiple times on entity", entity, value);
        } else if(value && value[0]) {
          elem.setAttribute("checked", "true");
        } else {
          elem.removeAttribute("checked");
        }

      } else {
        value = value && value.join(", ");
        if(value === undefined) {
          elem.removeAttribute(attribute);
        } else {
          elem.setAttribute(attribute, value);
        }
      }
    }

    let attrs = Object.keys(entity);
  }

  for(let entityId of regenClassesFor) {
    let elem = activeElements[entityId];
    if(!elem) continue;
    let entity = records[entityId];
    let value = entity["class"];
    if(!value) {
      elem.className = "";
    } else {
      let neue:string[] = [];
      for(let klassId of value) {
        if(activeClasses[klassId] !== undefined && records[klassId] !== undefined) {
          let klass = records[klassId];
          for(let name in klass) {
            if(!klass[name]) continue;
            if(klass[name].length > 1) {
              console.error("Unable to set class attribute to multiple values on entity", entity, name, klass[name]);
              continue;
            }
            if(klass[name][0] && neue.indexOf(name) === -1) {
              neue.push(name);
            }
          }
        } else {
          neue.push(klassId);
        }
      }
      elem.className = neue.join(" ");
    }
  }

  for(let entityId of regenStylesFor) {
    let elem = activeElements[entityId];
    if(!elem) continue;
    let entity = records[entityId];
    let value = entity["style"];
    elem.removeAttribute("style"); // @FIXME: This could be optimized to care about the diff rather than blowing it all away
    if(value) {
      let neue:string[] = [];
      for(let styleId of value) {
        if(activeStyles[styleId]) {
          let style = records[styleId];
          for(let attr in style) {
            (elem as any).style[attr] = style[attr] && style[attr].join(", ");
          }
        } else {
          neue.push(styleId);
        }
      }
      if(neue.length) {
        let s = elem.getAttribute("style");
        elem.setAttribute("style",  (s ? (s + "; ") : "") + neue.join("; "));
      }
    }
  }

  if(lastFocusPath && lastActiveElement && isInputElem(lastActiveElement)) {
    let current = activeElements.root;
    let ix = 0;
    for(let segment of lastFocusPath) {
      current = current.childNodes[segment] as RecordElement;
      if(!current) {
        lastActiveElement.blur();
        lastFocusPath = null;
        break;
      }
      ix++;
    }
    if(current && current.entity !== lastActiveElement.entity) {
      let curElem = current as HTMLElement;
      curElem.focus();
      if(isInputElem(lastActiveElement) && isInputElem(current) && selectableTypes[lastActiveElement.type] && selectableTypes[current.type]) {
        current.setSelectionRange(lastActiveElement.selectionStart, lastActiveElement.selectionEnd);
      }
    }
  }
  _suppressBlur = false
}

//---------------------------------------------------------
// Event bindings to forward events to the server
//---------------------------------------------------------
function sendEvent(objs) {
  connection.sendEvent(objs);
}
window.addEventListener("click", function(event) {
  let {target} = event;
  let current = target as RecordElement;
  let objs:any[] = [];
  while(current) {
    if(current.entity) {
      let tag = ["click"];
      if(current == target) {
        tag.push("direct-target");
      }
      objs.push({tag, element: current.entity});
    }
    current = current.parentElement;
  }
  sendEvent(objs);
});
window.addEventListener("dblclick", function(event) {
  let {target} = event;
  let current = target as RecordElement;
  let objs:any[] = [];
  while(current) {
    if(current.entity) {
      let tag = ["double-click"];
      if(current == target) {
        tag.push("direct-target");
      }
      objs.push({tag, element: current.entity});
    }
    current = current.parentElement;
  }
  sendEvent(objs);
});

window.addEventListener("input", function(event) {
  let target = event.target as (RecordElement & HTMLInputElement);
  if(target.entity) {
    if(!sentInputValues[target.entity]) {
      sentInputValues[target.entity] = [];
    }
    sentInputValues[target.entity].push(target.value);
    sendEvent([{tag: ["change"], element: target.entity, value: target.value}]);
  }
});
window.addEventListener("change", function(event) {
  let target = event.target as (RecordElement & (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement));
  if(target.tagName == "INPUT" || target.tagName == "TEXTAREA") return;
  if(target.entity) {
    if(!sentInputValues[target.entity]) {
      sentInputValues[target.entity] = [];
    }
    let value = target.value;

    if(isSelectElem(target)) {
      value = target.options[target.selectedIndex].value;
    }

    sentInputValues[target.entity!].push(value);
    let tag = ["change"];
    if(target == target) {
      tag.push("direct-target");
    }
    sendEvent([{tag, element: target.entity, value: target.value}]);
  }
});

function getFocusPath(target) {
  let root = activeElements.root;
  let current = target;
  let path:string[] = [];
  while(current !== root && current) {
    let parent = current.parentElement;
    path.unshift(Array.prototype.indexOf.call(parent.children, current));
    current = parent;
  }
  return path;
}

window.addEventListener("focus", function(event) {
  let target = event.target as RecordElement;
  if(target.entity) {
    let objs = [{tag: ["focus"], element: target.entity}];
    sendEvent(objs);
    lastFocusPath = getFocusPath(target);
  }
}, true);

window.addEventListener("blur", function(event) {
  if(_suppressBlur) {
    event.preventDefault();
    return;
  }
  let target = event.target as RecordElement;
  if(target.entity) {
    let objs = [{tag: ["blur"], element: target.entity}];
    sendEvent(objs);

    if(lastFocusPath) {
      let curFocusPath = getFocusPath(target);
      if(curFocusPath.length === lastFocusPath.length) {
        let match = true;
        for(let ix = 0; ix < curFocusPath.length; ix++) {
          if(curFocusPath[ix] !== lastFocusPath[ix]) {
            match = false;
            break;
          }
        }
        if(match) {
          lastFocusPath = null;
        }
      }
    }
  }
}, true);


let keyMap = {13: "enter", 27: "escape"}
window.addEventListener("keydown", function(event) {
  let {target} = event;
  let current = target as RecordElement;
  let objs:any[] = [];
  let key = event.keyCode;
  while(current) {
    if(current.entity) {
      let tag = ["keydown"];
      if (current == target) {
        tag.push("direct-target");
      }
      objs.push({tag, element: current.entity, key: keyMap[key] || key});
    }
    current = current.parentElement;
  }
  sendEvent(objs);
});

window.addEventListener("keyup", function(event) {
  let {target} = event;
  let current = target as RecordElement;
  let objs:any[] = [];
  let key = event.keyCode;
  while(current) {
    if(current.entity) {
      let tag = ["keyup"];
      if (current == target) {
        tag.push("direct-target");
      }
      objs.push({tag, element: current.entity, key: keyMap[key] || key});
    }
    current = current.parentElement;
  }
  objs.push({tag: ["keyup"], element: "window", key});
  sendEvent(objs);
});


//---------------------------------------------------------
// Editor Renderer
//---------------------------------------------------------
let activeLayers = {};
let editorParse = {};
let allNodeGraphs = {};
let showGraphs = false;

function injectProgram(node, elem) {
  node.appendChild(activeElements.root);
}

export function renderEve() {
  renderer.render([{c: "application-container", postRender: injectProgram}]);
}
