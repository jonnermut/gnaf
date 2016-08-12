var request = require('request');
var fs = require('fs');

Array.prototype.flatMap = function(f) {
  return Array.prototype.concat.apply([], this.map(f));
}

/**
 * Usage: node src/main/node/search.js input.json [fuzzy]
 * TODO: add proper command line option handling, add options to set numHits and bulk
 */
var path = process.argv[2]; // 0 -> node; 1 -> src/main/script/search.js; 2 -> input.json
var fuzzy = process.argv.length > 3;
var numHits = 10;

var addr = JSON.parse(fs.readFileSync(path, "utf8"));
// console.log('addr', addr);

var bulk = 10;
var batches = [];
for (i = 0; i < addr.length; i += bulk) batches.push(addr.slice(i, Math.min(i + bulk, addr.length)));
// console.log('batches', batches);

/**
 * If we don't specify "fields" we get _source.d61AddressNoAlias as a String
 * however if we do specify "fields" _source is omitted and we get fields.d61AddressNoAlias as an array of Strings (with just 1 element).
 */
var query = fuzzy ? a =>
({
  query:{ match:{ d61Address:{ query: a, fuzziness: 2, prefix_length: 2 }}},
  rescore:{ query:{ rescore_query:{ match:{ d61Address:{ query: a }}}, query_weight: 0 }},
  fields: [ "d61AddressNoAlias" ],
  size: numHits
})
                  : a =>
({
  query:{ match:{ d61Address: a }},
  fields:[ "d61AddressNoAlias" ],
  size:numHits
});

/** return array[i] = index j where esHits.responses[i].hits.hits[j]._id == batch[i].addressDetailPid */
var compare = (batch, esHits) => batch.map( (x, i) =>
  esHits.responses[i].hits.hits.findIndex(h => h.fields.d61AddressNoAlias[0].indexOf(x.address) != -1)
);

/** add histogram of values from arr into Map m (and return m)
 *  map keys are values from arr and map values are the occurrence count of the value in arr
 *  e.g. histogram(new Map(), arr) returns the histogram of arr
 */
function histogram(m, arr) {
  return arr.reduce((m, x) => {
    var n = m.get(x);
    m.set(x, n ? n + 1 : 1);
    return m;
  }, m);
}

/**
 * 
 * @param map updated map: key -> array of value
 * @param key
 * @param value
 */
function multiMapAppend(map, key, value) {
  var arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  };
  arr.push(value);
}

function mapToArr(m) {
  var a = [];
  for (e of m) a.push(e);
  return a;
} 

/** print Map m as tab separated values: {key}\t{value} */
function done(histMap, errMap) {
  console.log(JSON.stringify({ histogram: mapToArr(histMap), errors: mapToArr(errMap) }));
}

/**
 * 
 * @param i process addresses from batches[i]
 * @param histMap updated histogram (index of correct hit (0 in good cases) -> occurrence count for this index)
 * @param errMap (index of correct hit (only for non-zero cases) -> array of addresses with this index)
 */
function doBatch(i, histMap, errMap) {
  var batch = batches[i];
  
  var rescore = esHits => {
    esHits.responses.forEach(r => r.hits.hits.sort( (a, b) =>
      b._score != a._score ? b._score - a._score : a.fields.d61AddressNoAlias[0].length - b.fields.d61AddressNoAlias[0].length
    ));
    return esHits;
  };
  
  // console.log('batch', batch);
  var data = batch.flatMap(a => [ '{}', JSON.stringify(query(a.query)) ]).join('\n') + '\n';
  // console.log('data', data);

  request.post( { url: 'http://localhost:9200/gnaf/_msearch', body: data }, (error, response, body) => {
    if (error) console.log('error', error)
    else {
      // console.log('statusCode', response.statusCode, 'body', body);
      var esHits = rescore(JSON.parse(body));
      // console.log('esHits', JSON.stringify(esHits));
      var idxs = compare(batch, esHits);
      // console.log('idxs', idxs);
      histogram(histMap, idxs);
      // console.log('histMap', histMap);
      idxs.forEach((v, i) => { if (v != 0) multiMapAppend(errMap, v, batch[i].query) });
      if (i + 1 < batches.length) doBatch(i + 1, histMap, errMap);
      else done(histMap, errMap);
    }
  });
}

doBatch(0, new Map(), new Map());
