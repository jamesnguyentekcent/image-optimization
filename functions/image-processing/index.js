// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const AWS = require('aws-sdk');
const https = require('https');
const Sharp = require('sharp');

const S3 = new AWS.S3({ signatureVersion: 'v4', httpOptions: { agent: new https.Agent({ keepAlive: true }) } });
const S3_ORIGINAL_IMAGE_BUCKET = process.env.originalImageBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;

// For image auto resizing only
const AUTO_TRANSFORM_IMAGE_SIZES = process.env.autoTransformImageSizes;
const AUTO_TRANSFORM_IMAGE_FORMATS = process.env.autoTransformImageFormats;

const SECRET_KEY = process.env.secretKey;
const MAX_IMAGE_SIZE = parseInt(process.env.maxImageSize);

exports.handler = async (event) => {
    let originalImagePath;
    let operationsPrefix;
	console.log('Start the Image Resize')
	// Get the object from the event and show its content type
    if(event.Records != null && event.Records[0].eventName.includes('ObjectCreated'))
    {
		console.log('S3 Event')
		originalImagePath = event.Records[0].s3.object.key;
		// Expected sample value: 'org;width=360&height=270;height=480;width=1280'
		const autoTransformImageSizes = AUTO_TRANSFORM_IMAGE_SIZES.split(';');
		// Expected sample value: 'org;jpeg;avif;webp'
		const autoTransformImageFormats = AUTO_TRANSFORM_IMAGE_FORMATS.split(';');
		console.log('Content: ', originalImagePath, autoTransformImageSizes, autoTransformImageFormats)
		// Handling image transformations
		autoTransformImageSizes.forEach(async (size) => {
			autoTransformImageFormats.forEach(async (format) => {
				const operationsPrefix = `${size},format=${format}`;
				await transformImage(originalImagePath, operationsPrefix); });});
    } else {
		console.log('On-the fly approach')
		// First validate if the request is coming from CloudFront
		if (!event.headers['x-origin-secret-header'] || !(event.headers['x-origin-secret-header'] === SECRET_KEY)) return sendError(403, 'Request unauthorized', event);
		// Validate if this is a GET request
		// An example of expected path is /sample/1.jpeg/format=auto,width=100 or /sample/1.jpeg/original where /sample/1.jpeg is the path of the original image
		if (!event.requestContext || !event.requestContext.http || !(event.requestContext.http.method === 'GET')) return sendError(400, 'Only GET method is supported', event);
		var imagePathArray = event.requestContext.http.path.split('/');
		// get the requested image operations
		operationsPrefix = imagePathArray.pop();
		// get the original image path sample/1.jpg
		imagePathArray.shift();
		originalImagePath = imagePathArray.join('/');
		// Handling image transformations
		await transformImage(originalImagePath, operationsPrefix);
	}

};

// Handling image transformations
async function transformImage(originalImagePath, operationsPrefix) {
	console.log('Start the transform image')
	var startTime = performance.now();
	
    // Downloading original image
    let originalImage;
    let contentType;
    try {
        originalImage = await S3.getObject({ Bucket: S3_ORIGINAL_IMAGE_BUCKET, Key: originalImagePath }).promise();
        contentType = originalImage.ContentType;
    } catch (error) {
        return sendError(500, 'error downloading original image', error);
    }
	console.log('Start the transform image1')

	var operationsPrefixArray = event.requestContext.http.path.split('/');
    let transformedImage = Sharp(originalImage.Body, { failOn: 'none', animated: true });
    // Get image orientation to rotate if needed
    const imageMetadata = await transformedImage.metadata();
    // Execute the requested operations 
    const operationsJSON = Object.fromEntries(operationsPrefix.split(',').map(operation => operation.split('=')));
    // Variable holding the server timing header value
    var timingLog =  'img-download;dur=' + parseInt(performance.now() - startTime);
    startTime = performance.now();
    try {
        // check if resizing is requested
        var resizingOptions = {};
        if (operationsJSON['width']) resizingOptions.width = parseInt(operationsJSON['width']);
			console.log('Start the transform image2')

        if (operationsJSON['height']) resizingOptions.height = parseInt(operationsJSON['height']);
        if (resizingOptions) transformedImage = transformedImage.resize(resizingOptions);
        // check if rotation is needed
        if (imageMetadata.orientation) transformedImage = transformedImage.rotate();
			console.log('Start the transform image3')

        // check if formatting is requested
        if (operationsJSON['format']) {
            var isLossy = false;
            switch (operationsJSON['format']) {
                case 'jpeg': contentType = 'image/jpeg'; isLossy = true; break;
                case 'gif': contentType = 'image/gif'; break;
                case 'webp': contentType = 'image/webp'; isLossy = true; break;
                case 'png': contentType = 'image/png'; break;
                case 'avif': contentType = 'image/avif'; isLossy = true; break;
                default: contentType = 'image/jpeg'; isLossy = true;
            }
            if (operationsJSON['quality'] && isLossy) {
                transformedImage = transformedImage.toFormat(operationsJSON['format'], {
                    quality: parseInt(operationsJSON['quality']),
                });
            } else transformedImage = transformedImage.toFormat(operationsJSON['format']);
        }
			console.log('Start the transform image4')

        transformedImage = await transformedImage.toBuffer();
    } catch (error) {
        return sendError(500, 'error transforming image', error);
    }
    timingLog = timingLog + ',img-transform;dur=' + parseInt(performance.now() - startTime);
    	console.log('Start the transform image5')

    // Graceful handleing of generated images bigger than a specified limit (e.g. Lambda output object limit)
    const imageTooBig = Buffer.byteLength(transformedImage) > MAX_IMAGE_SIZE;
	console.log('Start the transform image6')

    // upload transformed image back to S3 if required in the architecture
    if (S3_TRANSFORMED_IMAGE_BUCKET) {
        startTime = performance.now();
        try {
            await S3.putObject({
                Body: transformedImage,
                Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
                Key: originalImagePath + '/' + operationsPrefix,
                ContentType: contentType,
                Metadata: {
                    'cache-control': TRANSFORMED_IMAGE_CACHE_TTL,
                },
            }).promise();
            timingLog = timingLog + ',img-upload;dur=' +parseInt(performance.now() - startTime);
            // If the generated image file is too big, send a redirection to the generated image on S3, instead of serving it synchronously from Lambda. 
            if (imageTooBig) {
                return {
                    statusCode: 302,
                    headers: {
                        'Location': '/' + originalImagePath + '?' + operationsPrefix.replace(/,/g, "&"),
                        'Cache-Control' : 'private,no-store',
                        'Server-Timing': timingLog
                    }
                };
            }
        } catch (error) {
            logError('Could not upload transformed image to S3', error);
        }
        	console.log('Start the transform image7')

    }

    // Return error if the image is too big and a redirection to the generated image was not possible, else return transformed image
    if (imageTooBig) {
        return sendError(403, 'Requested transformed image is too big', '');
    } else return {
        statusCode: 200,
        body: transformedImage.toString('base64'),
        isBase64Encoded: true,
        headers: {
            'Content-Type': contentType,
            'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL,
            'Server-Timing': timingLog
        }
    };
		console.log('Start the transform image8')

}

function sendError(statusCode, body, error) {
    logError(body, error);
    return { statusCode, body };
}

function logError(body, error) {
    console.log('APPLICATION ERROR', body);
    console.log(error);
}
