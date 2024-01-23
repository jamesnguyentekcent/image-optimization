// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Sharp from 'sharp';

const s3Client = new S3Client();
const S3_ORIGINAL_IMAGE_BUCKET = process.env.originalImageBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;

// For image auto resizing only
const AUTO_TRANSFORM_IMAGE_SIZES = process.env.autoTransformImageSizes;
const AUTO_TRANSFORM_IMAGE_FORMATS = process.env.autoTransformImageFormats;
const ALLOW_TRANSFORM_IMAGE_WIDTHS = process.env.allowTransformImageWidths;
const ALLOW_TRANSFORM_IMAGE_HEIGHTS = process.env.allowTransformImageHeights;

const SECRET_KEY = process.env.secretKey;
const MAX_IMAGE_SIZE = parseInt(process.env.maxImageSize);

export const handler = async (event) => {
    let originalImagePath;
    let operationsPrefix;
	// Get the object from the event and show its content type
    if(event.Records != null && event.Records[0].eventName.includes('ObjectCreated'))
    {
		originalImagePath = event.Records[0].s3.object.key;
		// Expected sample value: 'org|w=360,h=270|h=480|w=1280'
		const autoTransformImageSizes = AUTO_TRANSFORM_IMAGE_SIZES.split('|');
		// Expected sample value: 'org|jpeg|avif|webp'
		const autoTransformImageFormats = AUTO_TRANSFORM_IMAGE_FORMATS.split('|');
		console.log('S3 Upload Request: ', originalImagePath, autoTransformImageSizes, autoTransformImageFormats)
	
		// Handling image transformations
		for (const size of autoTransformImageSizes) {
			for (const format of autoTransformImageFormats) {
				const operationsPrefix = `${size},f=${format}`;
                await transformImage(originalImagePath, operationsPrefix);				
			}
		}
    } else {
		// First validate if the request is coming from CloudFront
		if (!event.headers['x-origin-secret-header'] || !(event.headers['x-origin-secret-header'] === SECRET_KEY)) return sendError(403, 'Request unauthorized', event);
		// Validate if this is a GET request
		// An example of expected path is /sample/1.jpeg/f=auto,w=100 or /sample/1.jpeg/original where /sample/1.jpeg is the path of the original image
		if (!event.requestContext || !event.requestContext.http || !(event.requestContext.http.method === 'GET')) return sendError(400, 'Only GET method is supported', event);
		var imagePathArray = event.requestContext.http.path.split('/');

		// get the requested image operations
		operationsPrefix = imagePathArray.pop();

		// get the original image path sample/1.jpg
		imagePathArray.shift();
		originalImagePath = imagePathArray.join('/');
		// Handling image transformations
		console.log('On-the-fly Request: ', originalImagePath, operationsPrefix)
		return await transformImage(originalImagePath, operationsPrefix);
	}
};

// Handling image transformations
async function transformImage(originalImagePath, operationsPrefix) {
	// Downloading original image
    let originalImageBody;
    let contentType;
    try {
        const getOriginalImageCommand = new GetObjectCommand({ Bucket: S3_ORIGINAL_IMAGE_BUCKET, Key: originalImagePath });
        const getOriginalImageCommandOutput = await s3Client.send(getOriginalImageCommand);
        console.log(`Got response from S3 for ${originalImagePath}`);

        originalImageBody = getOriginalImageCommandOutput.Body.transformToByteArray();
        contentType = getOriginalImageCommandOutput.ContentType;
    } catch (error) {
        return sendError(500, 'Error downloading original image', error);
    }
    let transformedImage = Sharp(await originalImageBody, { failOn: 'none', animated: true });
    // Get image orientation to rotate if needed
    const imageMetadata = await transformedImage.metadata();
    // Execute the requested operations 
    const operationsJSON = Object.fromEntries(operationsPrefix.split(',').map(operation => operation.split('=')));

    try {
        // check if resizing is requested
        var resizingOptions = {};
		if(!operationsJSON['org'])
		{
            var imageTransformWidth = parseInt(operationsJSON['w'])
            var imageTransformHeight = parseInt(operationsJSON['h'])
            if (ALLOW_TRANSFORM_IMAGE_WIDTHS !== '' && ALLOW_TRANSFORM_IMAGE_HEIGHTS !== '')
            {
                // 	If the resizing image size is not supported, returned error. Expected sample value: '360|270|480|1280'
                const allowTransformImageWidths = ALLOW_TRANSFORM_IMAGE_WIDTHS.split('|');
                const allowTransformImageHeights = ALLOW_TRANSFORM_IMAGE_HEIGHTS.split('|');
                if (allowTransformImageWidths. allowTransformImageWidths.indexOf(imageTransformWidth) === -1 || allowTransformImageHeights.indexOf(imageTransformHeight) === -1) {
                    return sendError(404, 'Do not support this output size.', '')
                }
            }
			if (operationsJSON['w']) resizingOptions.width = imageTransformWidth;
			if (operationsJSON['h']) resizingOptions.height = imageTransformHeight;
			if (resizingOptions) transformedImage = transformedImage.resize(resizingOptions);
			// check if rotation is needed
			if (imageMetadata.orientation) transformedImage = transformedImage.rotate();
		}
        
        // check if formatting is requested
        if (operationsJSON['f'] && operationsJSON['f'] != 'org') {
            var isLossy = false;
            switch (operationsJSON['f']) {
                case 'jpeg': contentType = 'image/jpeg'; isLossy = true; break;
                case 'gif': contentType = 'image/gif'; break;
                case 'webp': contentType = 'image/webp'; isLossy = true; break;
                case 'png': contentType = 'image/png'; break;
                case 'avif': contentType = 'image/avif'; isLossy = true; break;
                default: contentType = 'image/jpeg'; isLossy = true;
            }
            if (operationsJSON['quality'] && isLossy) {
                transformedImage = transformedImage.toFormat(operationsJSON['f'], {
                    quality: parseInt(operationsJSON['quality']),
                });
            } else transformedImage = transformedImage.toFormat(operationsJSON['f']);
        }
        transformedImage = await transformedImage.toBuffer();
    } catch (error) {
        return sendError(500, 'error transforming image', error);
    }

    // handle gracefully generated images bigger than a specified limit (e.g. Lambda output object limit)
    const imageTooBig = Buffer.byteLength(transformedImage) > MAX_IMAGE_SIZE;

    // upload transformed image back to S3 if required in the architecture
	try {
		const putImageCommand = new PutObjectCommand({
			Body: transformedImage,
			Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
			Key: originalImagePath + '/' + operationsPrefix.replace('org,f=org','').replace('org,','').replace(',f=org',''),
			ContentType: contentType,
			Metadata: {
				'cache-control': TRANSFORMED_IMAGE_CACHE_TTL,
			},
		})
        await s3Client.send(putImageCommand);
        if (imageTooBig) {
            return {
                statusCode: 302,
                headers: {
                    'Location': '/' + originalImagePath + '?' + operationsPrefix.replace(/,/g, "&"),
                    'Cache-Control': 'private,no-store',
                    'Server-Timing': timingLog
                }
            };
        }
	} catch (error) {
		sendError('APPLICATION ERROR', 'Could not upload transformed image to S3', error);
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
            'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL
        }
    };
}

function sendError(statusCode, body, error) {
    console.log('APPLICATION ERROR', body);
    console.log(error);
    return { statusCode, body };
}