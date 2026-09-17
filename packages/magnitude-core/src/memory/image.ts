// Default import avoids Node 18/22's incomplete CJS named-export detection for Image.
import baml, { type Image as BamlImage } from '@boundaryml/baml';
import { StoredMedia } from './serde';
import { Sharp } from 'sharp';
import sharp from 'sharp';

export type ImageMediaType = `image/${string}`;//'png' | 'jpeg';

export class Image {
    /**
     * Wrapper for a Sharp image with conveniences to go to/from base64, convert to BAML, or serialize as JSON
     */
    // represents the start of a pipeline
    private img: Sharp;
    private encoded?: Promise<{ base64: string; format: string; width: number; height: number }>;
    // Cached metadata property for sync access + required width/height properties
    //private metadata: Sharp['metadata'] & { width: number, height: number };
    //private content: string;
    //private mediaType: ImageMediaType;

    //constructor(type: 'url' | 'base64', content: string, mediaType: ImageMediaType) {
    constructor(img: Sharp) {
        // Own the pipeline configuration; later caller edits cannot change it.
        this.img = img.clone();
    }

    static fromBase64(base64: string) {
        // if (!mediaType) {
        //     const match = base64.match(/^data:(.*?);base64,/);
        //     mediaType = match ? `image/${match[1]}` : undefined;
        // }
        // if (!mediaType) {
        //     throw new Error("Image media type must be specified either in base64 encoded string or in mediaType parameter");
        // }
        const base64Data = base64.replace(/^data:.*?;base64,/, '');
        //return new Image('base64', base64Data, mediaType);
        return new Image(sharp(Buffer.from(base64Data, 'base64')));
    }

    async getFormat(): Promise<keyof sharp.FormatEnum> {
        return (await this.encode()).format as keyof sharp.FormatEnum;
    }

    private encode() {
        // Share in-flight work across rendering, deduplication and checkpoints.
        // Retain encoded strings, not both a Buffer and its base64 copy.
        return this.encoded ??= this.img.clone().toBuffer({ resolveWithObject: true }).then(({ data, info }) => ({
            base64: data.toString('base64'), format: info.format, width: info.width, height: info.height,
        })).catch(error => {
            this.encoded = undefined;
            throw error;
        });
    }

    /**
     * Convert the image to a JSON representation
     */
    async toJson(): Promise<StoredMedia> {
        // Source metadata can describe raw input or a pre-conversion format.
        // Use the format of the bytes emitted by the Sharp pipeline.
        const { base64, format } = await this.encode();
        return {
            type: 'media',
            format,
            storage: 'base64',
            base64,
        };
    }

    async toBase64(): Promise<string> {
        return (await this.encode()).base64;
    }

    async toBaml(): Promise<BamlImage> {
        const { format, base64 } = await this.toJson();
        return baml.Image.fromBase64(`image/${format}`, base64);
    }

    async saveToFile(filepath: string): Promise<void> {
        await this.img.clone().toFile(filepath);
        //console.log(`Image saved to ${filepath}`);
    }

    async getDimensions(): Promise<{ width: number, height: number }> {
        //const { width, height } = await this.img.clone().metadata();
        // Need to convert to buffer in order for metadata to be updated - otherwise it returns metadata of the original image
        const { width, height } = await this.encode();
        if (!width || !height) throw new Error("Unable to get dimensions from image");
        return { width, height };
    }

    async resize(width: number, height: number): Promise<Image> {
        // if (this.type != 'base64') throw new Error("Only base64 images can be resized");
        // const img = sharp(Buffer.from(this.content));
        // const metadata = await img.metadata();
        //console.log(`resizing to: ${width}, ${height}`);

        //console.log("Before resizing:", await this.getDimensions());
        
        // if (!metadata.width || !metadata.height)
        const resizedImage = new Image(this.img.clone().resize({
            // Round width/height since sometimes they are floats due to rounding errors - sharp will throw if not integers
            width: Math.round(width),
            height: Math.round(height),
            fit: 'fill', // exact size, no cropping
            kernel: sharp.kernel.lanczos3
        }));

        //resizedImage.saveToFile('foo.png');

        //console.log("After resizing:", await resizedImage.getDimensions());

        return resizedImage
    }
}
