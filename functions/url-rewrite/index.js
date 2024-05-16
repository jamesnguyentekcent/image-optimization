// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

function handler(event) {
    var request = event.request;
    var originalImagePath = request.uri;
    var SUPPORTED_FORMATS = ['auto', 'jpg', 'jpeg', 'webp', 'avif', 'png'];
    var SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.webp', '.avif', '.png'];
    var TRANSFORMED_FOLDER_PREFIX = "transformed";
    var isTransformSupported = false;
    SUPPORTED_EXTENSIONS.forEach(function(format) {
        if (originalImagePath.endsWith(format)) {
            isTransformSupported = true;
        }
    })
    if (isTransformSupported) {
        //  validate, process and normalize the requested operations in query parameters
        var normalizedOperations = {};
        if (request.querystring) {
            Object.keys(request.querystring).forEach(operation => {
                switch (operation.toLowerCase()) {
                    case 'f': 
                        if (request.querystring[operation]['value'] && SUPPORTED_FORMATS.includes(request.querystring[operation]['value'].toLowerCase())) {
                            var format = request.querystring[operation]['value'].toLowerCase(); // normalize to lowercase
                            if (format === 'auto') {
                                format = 'jpeg';
                                if (request.headers['accept']) {
                                    if (request.headers['accept'].value.includes("avif")) {
                                        format = 'avif';
                                    } else if (request.headers['accept'].value.includes("webp")) {
                                        format = 'webp';
                                    } 
                                }
                            }
                            normalizedOperations['f'] = format;
                        }
                        break;
                    case 'w':
                        if (request.querystring[operation]['value']) {
                            var width = parseInt(request.querystring[operation]['value']);
                            if (!isNaN(width) && (width > 0)) {
                                // you can protect the Lambda function by setting a max value, e.g. if (width > 4000) width = 4000;
                                normalizedOperations['w'] = width.toString();
                            }
                        }
                        break;
                    case 'h':
                        if (request.querystring[operation]['value']) {
                            var height = parseInt(request.querystring[operation]['value']);
                            if (!isNaN(height) && (height > 0)) {
                                // you can protect the Lambda function by setting a max value, e.g. if (height > 4000) height = 4000;
                                normalizedOperations['h'] = height.toString();
                            }
                        }
                        break;
                    case 'mw':
                        if (request.querystring[operation]['value']) {
                            var maxWidth = parseInt(request.querystring[operation]['value']);
                            if (!isNaN(maxWidth) && (maxWidth > 0)) {
                                // you can protect the Lambda function by setting a max value, e.g. if (maxWidth > 4000) maxWidth = 4000;
                                normalizedOperations['mw'] = maxWidth.toString();
                            }
                        }
                        break;
                    case 'mh':
                        if (request.querystring[operation]['value']) {
                            var maxHeight = parseInt(request.querystring[operation]['value']);
                            if (!isNaN(maxHeight) && (maxHeight > 0)) {
                                // you can protect the Lambda function by setting a max value, e.g. if (maxHeight > 4000) maxHeight = 4000;
                                normalizedOperations['mh'] = maxHeight.toString();
                            }
                        }
                        break;
                    case 'q':
                        if (request.querystring[operation]['value']) {
                            var quality = parseInt(request.querystring[operation]['value']);
                            if (!isNaN(quality) && (quality > 0)) {
                                if (quality > 100) quality = 100;
                                normalizedOperations['q'] = quality.toString();
                            }
                        }
                        break;
                    default: break;
                }
            });
            //rewrite the path to normalized version if valid operations are found
            if (Object.keys(normalizedOperations).length > 0) {
                // put them in order
                var normalizedOperationsArray = [];
                if (normalizedOperations.f) normalizedOperationsArray.push('f='+normalizedOperations.f);
                if (normalizedOperations.q) normalizedOperationsArray.push('q='+normalizedOperations.q);
                if (normalizedOperations.w) normalizedOperationsArray.push('w='+normalizedOperations.w);
                if (normalizedOperations.h) normalizedOperationsArray.push('h='+normalizedOperations.h);
        		if (normalizedOperations.mw) normalizedOperationsArray.push('mw='+normalizedOperations.mw);
                if (normalizedOperations.mh) normalizedOperationsArray.push('mh='+normalizedOperations.mh);
                request.uri = originalImagePath + '/' + normalizedOperationsArray.join(',');     
            } else {
                // If no valid operation is found, flag the request with /original path suffix
                request.uri = originalImagePath + '/original';     
            }
        
        } else {
            // If no query strings are found, flag the request with /original path suffix
            request.uri = originalImagePath + '/original'; 
        }
        request.uri = '/' + TRANSFORMED_FOLDER_PREFIX + request.uri;
        // remove query strings
        request['querystring'] = {};
    }
    if(request.cookies.crafterSite.value){
        request.uri = '/' + request.cookies.crafterSite.value + request.uri;
    }
    return request;
}
