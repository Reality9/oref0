#!/usr/bin/env node

/*
  Determine Basal

  Released under MIT license. See the accompanying LICENSE.txt file for
  full terms and conditions

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
  THE SOFTWARE.
*/

var basal = require('oref0/lib/profile/basal');
var get_iob = require('oref0/lib/iob');

if (!module.parent) {
    var detectsensitivity = init();

    var glucose_input = process.argv.slice(2, 3).pop();
    var pumphistory_input = process.argv.slice(3, 4).pop();
    var isf_input = process.argv.slice(4, 5).pop()
    var basalprofile_input = process.argv.slice(5, 6).pop()
    var profile_input = process.argv.slice(6, 7).pop();

    if (!glucose_input || !pumphistory_input || !profile_input) {
        console.error('usage: ', process.argv.slice(0, 2), '<glucose.json> <pumphistory.json> <insulin_sensitivities.json> <basal_profile.json> <profile.json>');
        process.exit(1);
    }
    
    var fs = require('fs');
    try {
        var cwd = process.cwd();
        var glucose_data = require(cwd + '/' + glucose_input);
        if (glucose_data.length < 72) {
            console.log('Error: not enough glucose data to calculate autosens.');
            process.exit(2);
        }

        var pumphistory_data = require(cwd + '/' + pumphistory_input);
        var profile = require(cwd + '/' + profile_input);
        //console.log(profile);
        var glucose_status = detectsensitivity.getLastGlucose(glucose_data);
        var isf_data = require(cwd + '/' + isf_input);
        if (isf_data.units !== 'mg/dL') {
            console.log('ISF is expected to be expressed in mg/dL.'
                    , 'Found', isf_data.units, 'in', isf_input, '.');
            process.exit(2);
        }
        var basalprofile = require(cwd + '/' + basalprofile_input);

        var iob_inputs = {
            history: pumphistory_data
        , profile: profile
        //, clock: clock_data
        };
    } catch (e) {
        return console.error("Could not parse input data: ", e);
    }
    var avgDeltas = [];
    var bgis = [];
    var deviations = [];
    var deviationSum = 0;
    for (var i=0; i < glucose_data.length-3; ++i) {
        //console.log(glucose_data[i]);
        var bgTime;
        if (glucose_data[i].display_time) {
            bgTime = new Date(glucose_data[i].display_time.replace('T', ' '));
        } else if (glucose_data[i].dateString) {
            bgTime = new Date(glucose_data[i].dateString);
        } else { console.error("Could not determine last BG time"); }
        //console.log(bgTime);
        var bg = glucose_data[i].glucose;
        if ( bg < 40 || glucose_data[i+3].glucose < 40) {
            process.stderr.write("!");
            continue;
        }
        var avgDelta = (bg - glucose_data[i+3].glucose)/3;
        avgDelta = avgDelta.toFixed(2);
        iob_inputs.clock=bgTime;
        iob_inputs.profile.current_basal = basal.basalLookup(basalprofile, bgTime);
        //console.log(JSON.stringify(iob_inputs.profile));
        var iob = get_iob(iob_inputs);
        //console.log(JSON.stringify(iob));

        //var bgi = -iob.activity*profile.sens;
        var bgi = Math.round(( -iob.activity * profile.sens * 5 )*100)/100;
        bgi = bgi.toFixed(2);
        deviation = avgDelta-bgi;
        deviation = deviation.toFixed(2);
        //if (deviation < 0 && deviation > -2) {
            //console.log("BG: "+bg+", avgDelta: "+avgDelta+", BGI: "+bgi+", deviation: "+deviation);
        //}
        process.stderr.write(".");

        avgDeltas.push(avgDelta);
        bgis.push(bgi);
        deviations.push(deviation);
        deviationSum += parseFloat(deviation);

    }
    console.error("");
    //console.log(JSON.stringify(avgDeltas));
    //console.log(JSON.stringify(bgis));
    avgDeltas.sort(function(a, b){return a-b});
    bgis.sort(function(a, b){return a-b});
    deviations.sort(function(a, b){return a-b});
    for (var i=0.60; i > 0.25; i = i - 0.02) {
        console.error("p="+i.toFixed(2)+": "+percentile(avgDeltas, i).toFixed(2)+", "+percentile(bgis, i).toFixed(2)+", "+percentile(deviations, i).toFixed(2));
    }
    pSensitive = percentile(deviations, 0.50);
    pResistant = percentile(deviations, 0.30);
    //p30 = percentile(deviations, 0.3);

    average = deviationSum / deviations.length;

    console.error("Mean deviation: "+average.toFixed(2));
    var basalOff = 0;

    if(pSensitive < 0) { // sensitive
        basalOff = pSensitive * (60/5) / profile.sens;
        console.error("Excess insulin sensitivity detected");
    } else if (pResistant > 0) { // resistant
        basalOff = pResistant * (60/5) / profile.sens;
        console.error("Excess insulin resistance detected");
    } else {
        console.error("Sensitivity within normal ranges");
    }
    ratio = 1 + (basalOff / profile.max_daily_basal);
    // don't adjust more than 2x
    ratio = Math.max(ratio, 0.5);
    ratio = Math.min(ratio, 2);
    ratio = Math.round(ratio*100)/100;
    newisf = profile.sens / ratio;
    console.error("Basal adjustment "+basalOff.toFixed(2)+"U/hr");
    console.error("Ratio: "+ratio*100+"%: new ISF: "+newisf.toFixed(1)+"mg/dL/U");
    var sensAdj = {
        "ratio": ratio
    }
    return console.log(JSON.stringify(sensAdj));
}

function init() {

    var detectsensitivity = {
        name: 'detect-sensitivity'
        , label: "OpenAPS Detect Sensitivity"
    };

    detectsensitivity.getLastGlucose = require('../lib/glucose-get-last');
    //detectsensitivity.detect_sensitivity = require('../lib/determine-basal/determine-basal');
    return detectsensitivity;

}
module.exports = init;

// From https://gist.github.com/IceCreamYou/6ffa1b18c4c8f6aeaad2
// Returns the value at a given percentile in a sorted numeric array.
// "Linear interpolation between closest ranks" method
function percentile(arr, p) {
    if (arr.length === 0) return 0;
    if (typeof p !== 'number') throw new TypeError('p must be a number');
    if (p <= 0) return arr[0];
    if (p >= 1) return arr[arr.length - 1];

    var index = arr.length * p,
        lower = Math.floor(index),
        upper = lower + 1,
        weight = index % 1;

    if (upper >= arr.length) return arr[lower];
    return arr[lower] * (1 - weight) + arr[upper] * weight;
}

// Returns the percentile of the given value in a sorted numeric array.
function percentRank(arr, v) {
    if (typeof v !== 'number') throw new TypeError('v must be a number');
    for (var i = 0, l = arr.length; i < l; i++) {
        if (v <= arr[i]) {
            while (i < l && v === arr[i]) i++;
            if (i === 0) return 0;
            if (v !== arr[i-1]) {
                i += (v - arr[i-1]) / (arr[i] - arr[i-1]);
            }
            return i / l;
        }
    }
    return 1;
}

